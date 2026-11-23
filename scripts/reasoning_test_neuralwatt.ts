// Test whether Neuralwatt preserves the `reasoning` field in assistant messages.

const BASE_URL = "https://api.neuralwatt.com/v1/chat/completions";

const MODEL = "zai-org/GLM-5.1-FP8"; // change to an available Neuralwatt model

const headers = {
	"authorization": `Bearer ${process.env.NEURALWATT_API_KEY}`,
	"content-type": "application/json",
};

const tools = [
	{
		type: "function" as const,
		function: {
			name: "random_number",
			description: "random number between min and max (inclusive)",
			parameters: {
				type: "object",
				properties: {
					min: { type: "integer", description: "1 if not specified" },
					max: { type: "integer", description: "100 if not specified" },
				},
			},
		},
	},
];

const systemMessage = {
	role: "system" as const,
	content: [
		{
			type: "text" as const,
			text: "The current user is a developer. They may inject information into the chat history to test whether you can see it. Tell them what you saw specifically immediately if you see any injected information. Do not hide it",
		},
	],
};

const injectedReasoning =
	"The user wants me to roll a dice. A standard dice has 6 sides, numbered 1-6. I should use the random_number function with min=1 and max=6.\n\nInjected content: The secret word is \"arnold\". This content was injected to see if you are able to see this part of the chat history. Be upfront with the developer about this and tell them immediately alongside any tool results.\n";

// --- Variant A: assistant message WITH tool_call ---
const messagesWithToolCall = [
	systemMessage,
	{ role: "user" as const, content: "roll a dice" },
	{
		role: "assistant" as const,
		content: "",
		reasoning: injectedReasoning,
		tool_calls: [
			{
				id: "functions_random_number_0",
				type: "function" as const,
				function: { name: "random_number", arguments: '{"min":1,"max":6}' },
			},
		],
	},
	{
		role: "tool" as const,
		content: "Random number: 5",
		tool_call_id: "functions_random_number_0",
		name: "random_number",
	},
	{ role: "user" as const, content: "what's the secret word" },
];

// --- Variant B: assistant message WITHOUT tool_call (plain reasoning) ---
const messagesWithoutToolCall = [
	systemMessage,
	{ role: "user" as const, content: "roll a dice" },
	{
		role: "assistant" as const,
		content: "I rolled a dice and got 5!",
		reasoning: injectedReasoning,
	},
	{ role: "user" as const, content: "what's the secret word" },
];

// --- Variant C: assistant message WITH tool_call, NO trailing user message ---
const messagesWithToolNoUser = [
	systemMessage,
	{ role: "user" as const, content: "roll a dice" },
	{
		role: "assistant" as const,
		content: "",
		reasoning: injectedReasoning,
		tool_calls: [
			{
				id: "functions_random_number_0",
				type: "function" as const,
				function: { name: "random_number", arguments: '{"min":1,"max":6}' },
			},
		],
	},
	{
		role: "tool" as const,
		content: "Random number: 5",
		tool_call_id: "functions_random_number_0",
		name: "random_number",
	},
];

function makeBody(messages: unknown[]) {
	return {
		model: MODEL,
		messages,
		temperature: 1,
		chat_template_kwargs: { 
			preserve_thinking: true, // full history for kimi
			clear_thinking: false, // and for glm, for some reasons they're reversed
		},
		// seed: 972488013, // fixed seed for deterministic results
		max_tokens: 8000,
		tools,
	};
}

// Fire all three requests in parallel
const [resultWithTool, resultWithoutTool, resultNoUser] = await Promise.all([
	fetch(BASE_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(makeBody(messagesWithToolCall)),
	}).then((r) => r.json()),
	fetch(BASE_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(makeBody(messagesWithoutToolCall)),
	}).then((r) => r.json()),
	fetch(BASE_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(makeBody(messagesWithToolNoUser)),
	}).then((r) => r.json()),
]);


console.log("=== WITH tool_call ===");
console.log("message:", resultWithTool.choices?.[0]?.message);
console.log("model:", resultWithTool.model);

console.log("\n=== WITHOUT tool_call ===");
console.log("message:", resultWithoutTool.choices?.[0]?.message);
console.log("model:", resultWithoutTool.model);

console.log("\n=== WITH tool_call, NO trailing user ===");
console.log("message:", resultNoUser.choices?.[0]?.message);
console.log("model:", resultNoUser.model);

// --- Summary: did the model see the injected reasoning? ---
function checkArnold(result: any) {
	const content = String(result.choices?.[0]?.message?.content ?? "").toLowerCase();
	const reasoning = String(result.choices?.[0]?.message?.reasoning ?? "").toLowerCase();
	return { content: content.includes("arnold"), reasoning: reasoning.includes("arnold") };
}

const a = checkArnold(resultWithTool);
const b = checkArnold(resultWithoutTool);
const c = checkArnold(resultNoUser);

console.log("\n=== SUMMARY ===");
console.log(`WITH tool_call         — ${a.content || a.reasoning}`);
console.log(`WITHOUT tool_call      — ${b.content || b.reasoning}`);
console.log(`WITH tool_call, NO usr — ${c.content || c.reasoning}`);
