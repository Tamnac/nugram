/**
 * One-time conversion of pointer forks into plain copies; run by `materializeForks` (db.ts).
 *
 * A pointer fork was a chat with parent_id and fork_message_id set that held only its
 * own messages: it read the parent's messages with id <= fork_message_id first, and
 * the parent's own pointer (if it was a fork itself) before those. Forks are plain
 * copies now, so every such chat gets the messages it used to borrow, in front of its
 * own. parent_id and fork_message_id stay as they are ("forked from here" info), and
 * the borrowed rows get `origin_id` pointing at the row they were copied from.
 *
 * Chats with a parent_id and no fork_message_id (sub-agent chats) never shared
 * anything and are not touched.
 *
 * Atomic and idempotent: one script on one connection (temp tables are per
 * connection, so it can't be split across `execute` calls), guarded by
 * `user_version`, which is set inside the same transaction. The guard is re-read
 * inside the transaction, so a second window that raced to start is a no-op.
 * `user_version` lives in the database file, so snapshots carry it and a restored
 * pre-migration backup is converted on its next init.
 *
 * Plain text, no semicolons inside comments or strings: the tests run this same script.
 */
export const FORK_MIGRATION_VERSION = 1;

export const FORK_MIGRATION_SQL = `
BEGIN IMMEDIATE;

DROP TABLE IF EXISTS temp._fork_plan;
DROP TABLE IF EXISTS temp._fork_cnt;
DROP TABLE IF EXISTS temp._own_plan;

-- One row per (fork, borrowed message) with the position it takes in the fork.
-- Walking up the chain, a message of an ancestor is visible only below the lowest
-- ceiling met on the way (the rule the recursive loader applied), oldest ancestors first.
CREATE TEMP TABLE _fork_plan AS
WITH RECURSIVE seg(fork, src, ceil, depth) AS (
	SELECT id, parent_id, fork_message_id, 0
	FROM chats
	WHERE parent_id IS NOT NULL AND fork_message_id IS NOT NULL
		AND (SELECT user_version FROM pragma_user_version) < ${FORK_MIGRATION_VERSION}
	UNION ALL
	SELECT seg.fork, p.parent_id, MIN(seg.ceil, p.fork_message_id), seg.depth + 1
	FROM seg JOIN chats p ON p.id = seg.src
	WHERE p.parent_id IS NOT NULL AND p.fork_message_id IS NOT NULL AND seg.depth < 64
)
SELECT seg.fork AS fork,
       m.id AS src_id,
       row_number() OVER (PARTITION BY seg.fork ORDER BY seg.depth DESC, m.idx) - 1 AS pos
FROM seg JOIN messages m ON m.chat_id = seg.src AND m.id <= seg.ceil;

CREATE TEMP TABLE _fork_cnt (fork TEXT PRIMARY KEY, n INTEGER NOT NULL);
INSERT INTO _fork_cnt SELECT fork, COUNT(*) FROM _fork_plan GROUP BY fork;

-- Where each fork's own messages go: after the borrowed ones, renumbered gap-free
-- (forks wrote them at in-memory positions, which left gaps).
CREATE TEMP TABLE _own_plan (id INTEGER PRIMARY KEY, idx INTEGER NOT NULL);
INSERT INTO _own_plan
SELECT o.id, c.n + o.rn
FROM (
	SELECT id, chat_id, row_number() OVER (PARTITION BY chat_id ORDER BY idx) - 1 AS rn
	FROM messages
	WHERE chat_id IN (SELECT fork FROM _fork_cnt)
) o
JOIN _fork_cnt c ON c.fork = o.chat_id;

-- Two steps through negative values, so UNIQUE (chat_id, idx) never sees a collision.
UPDATE messages SET idx = -idx - 1 WHERE chat_id IN (SELECT fork FROM _fork_cnt);
UPDATE messages
SET idx = (SELECT idx FROM _own_plan WHERE _own_plan.id = messages.id)
WHERE id IN (SELECT id FROM _own_plan);

INSERT INTO messages (chat_id, idx, role, content, current_version,
	thinking, thinking_signature, reasoning_enc, tool_calls, tool_results,
	tool_call_id, ids, name, models, providers, usage, timing, images, files, origin_id)
SELECT p.fork, p.pos, m.role, m.content, m.current_version,
	m.thinking, m.thinking_signature, m.reasoning_enc, m.tool_calls, m.tool_results,
	m.tool_call_id, m.ids, m.name, m.models, m.providers, m.usage, m.timing, m.images, m.files,
	COALESCE(m.origin_id, m.id)
FROM _fork_plan p JOIN messages m ON m.id = p.src_id
ORDER BY p.fork, p.pos;

DROP TABLE _own_plan;
DROP TABLE _fork_cnt;
DROP TABLE _fork_plan;

PRAGMA user_version = ${FORK_MIGRATION_VERSION};

COMMIT;
`;
