#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
//#region src/hooks/_env.ts
function hookEnvPath() {
	return join(homedir(), ".agentmemory", ".env");
}
function parseHookEnv(content) {
	const vars = {};
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		if (!key) continue;
		let val = trimmed.slice(eqIdx + 1).trim();
		const quoteChar = val[0] === "\"" || val[0] === "'" ? val[0] : "";
		if (quoteChar) {
			const closeIdx = val.indexOf(quoteChar, 1);
			if (closeIdx !== -1) val = val.slice(1, closeIdx);
		} else {
			const hashIdx = val.indexOf(" #");
			if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
		}
		vars[key] = val;
	}
	return vars;
}
/** Copy unset vars from ~/.agentmemory/.env into process.env. Real process
*  env always wins, matching config.ts's precedence. */
function hydrateHookEnv(envPath = hookEnvPath()) {
	if (!existsSync(envPath)) return;
	let vars;
	try {
		vars = parseHookEnv(readFileSync(envPath, "utf-8"));
	} catch {
		return;
	}
	for (const [key, value] of Object.entries(vars)) if (process.env[key] === void 0) process.env[key] = value;
}
//#endregion
//#region src/hooks/stop.ts
hydrateHookEnv();
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (!data || typeof data !== "object") return;
	if (isSdkChildContext(data)) return;
	const sessionId = data.session_id || data.sessionId || data.conversation_id || "unknown";
	fetch(`${REST_URL}/agentmemory/session/end`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ sessionId }),
		signal: AbortSignal.timeout(5e3)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=stop.mjs.map