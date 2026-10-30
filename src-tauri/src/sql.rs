//! Bulk SELECT that skips tauri-plugin-sql's per-cell allocation.
//!
//! The plugin's `select` copies every cell twice (`sqlite3_value_dup`, then a Rust
//! `String`), allocates a key `String` per cell and an `IndexMap` per row, and finally
//! re-escapes columns that already hold JSON. On a 4k-message chat that accounts for
//! ~790ms of a ~1050ms round trip.
//!
//! This borrows each cell as `&str`, appends the columns named in `json_columns`
//! verbatim, and hands the buffer back as a raw `ipc::Response` — serde never sees
//! the payload. Columns are validated before being inlined; a column holding
//! something other than JSON fails the whole call so the caller can fall back to
//! the plugin rather than receive a silently truncated document.

use serde_json::Value as JsonValue;
use sqlx::sqlite::SqliteValueRef;
use sqlx::{Column, Decode, Row, Sqlite, TypeInfo, ValueRef};
use std::io::Write;
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

#[tauri::command]
pub async fn select_json(
	db_instances: State<'_, DbInstances>,
	db: String,
	query: String,
	values: Vec<JsonValue>,
	json_columns: Vec<String>,
) -> Result<tauri::ipc::Response, String> {
	let instances = db_instances.0.read().await;
	let pool = instances
		.get(&db)
		.ok_or_else(|| format!("database {db} not loaded"))?;
	let pool = match pool {
		DbPool::Sqlite(pool) => pool,
		#[allow(unreachable_patterns)]
		_ => return Err("select_json requires a sqlite pool".into()),
	};

	// Whole numbers bind as INTEGER where the plugin binds every number as REAL, so
	// LIMIT/OFFSET and `id <= ?` keep integer affinity.
	let mut q = sqlx::query(&query);
	for value in values {
		q = match value {
			JsonValue::Null => q.bind(None::<String>),
			JsonValue::String(s) => q.bind(s),
			JsonValue::Bool(b) => q.bind(b),
			JsonValue::Number(n) => match n.as_i64() {
				Some(i) => q.bind(i),
				None => q.bind(n.as_f64().unwrap_or_default()),
			},
			other => q.bind(other.to_string()),
		};
	}

	let rows = q.fetch_all(pool).await.map_err(|e| e.to_string())?;

	// One `"name":` blob per column instead of the plugin's one `String` per cell.
	let mut keys: Vec<Vec<u8>> = Vec::new();
	let mut inline: Vec<bool> = Vec::new();
	if let Some(row) = rows.first() {
		for column in row.columns() {
			let mut key = Vec::with_capacity(column.name().len() + 4);
			serde_json::to_writer(&mut key, column.name()).map_err(|e| e.to_string())?;
			key.push(b':');
			keys.push(key);
			inline.push(json_columns.iter().any(|c| c == column.name()));
		}
	}

	let mut buf: Vec<u8> = Vec::with_capacity(rows.len() * 512 + 64);
	buf.push(b'[');
	for (r, row) in rows.iter().enumerate() {
		if r > 0 {
			buf.push(b',');
		}
		buf.push(b'{');
		for (c, key) in keys.iter().enumerate() {
			if c > 0 {
				buf.push(b',');
			}
			buf.extend_from_slice(key);
			let raw = row.try_get_raw(c).map_err(|e| e.to_string())?;
			append_value(&mut buf, raw, inline[c]).map_err(|e| {
				format!("column {} of row {r}: {e}", row.column(c).name())
			})?;
		}
		buf.push(b'}');
	}
	buf.push(b']');

	Ok(tauri::ipc::Response::new(buf))
}

/// sqlite reports a value's *runtime* type, so only TEXT/INTEGER/REAL/BLOB actually
/// turn up; the declared-type spellings are folded in anyway in case sqlx ever
/// resolves a column's declaration instead.
enum Kind {
	Text,
	Int,
	Real,
}

fn append_value<'r>(
	buf: &mut Vec<u8>,
	raw: SqliteValueRef<'r>,
	inline: bool,
) -> Result<(), String> {
	if raw.is_null() {
		buf.extend_from_slice(b"null");
		return Ok(());
	}

	// Resolved before the match body: a `type_info()` temporary in the scrutinee stays
	// alive for the whole match, and the arms need to move `raw` into `decode`.
	let kind = match raw.type_info().name() {
		"TEXT" => Kind::Text,
		"INTEGER" | "NUMERIC" | "BOOLEAN" => Kind::Int,
		"REAL" => Kind::Real,
		// Erroring beats emitting a silent null: the caller falls back to the plugin,
		// which knows how to encode blobs.
		other => return Err(format!("unsupported column type {other}")),
	};

	match kind {
		Kind::Text => {
			let s = <&str as Decode<'r, Sqlite>>::decode(raw).map_err(|e| e.to_string())?;
			if inline {
				// IgnoredAny walks the document without materializing it.
				serde_json::from_str::<serde::de::IgnoredAny>(s)
					.map_err(|e| format!("expected JSON, got {e}"))?;
				buf.extend_from_slice(s.as_bytes());
			} else {
				serde_json::to_writer(&mut *buf, s).map_err(|e| e.to_string())?;
			}
		}
		Kind::Int => {
			let n = <i64 as Decode<'r, Sqlite>>::decode(raw).map_err(|e| e.to_string())?;
			let _ = write!(buf, "{n}");
		}
		Kind::Real => {
			let f = <f64 as Decode<'r, Sqlite>>::decode(raw).map_err(|e| e.to_string())?;
			if f.is_finite() {
				let _ = write!(buf, "{f}");
			} else {
				buf.extend_from_slice(b"null");
			}
		}
	}

	Ok(())
}
