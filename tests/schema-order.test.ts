/**
 * Guards the deliberate ordering of the registered tool parameters.
 *
 * `description` must stay the first property so the model states its intent
 * before emitting the diff. TypeBox preserves object-literal insertion order
 * into the emitted schema, so reordering the literals in `extensions/index.ts`
 * would silently remove that nudge.
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import registerPiJournal from "../extensions/index";

interface RegisteredTool {
	name: string;
	parameters: unknown;
}

/**
 * Collect the tools an extension registers against a stubbed `ExtensionAPI`.
 *
 * @returns Registered tool definitions, in registration order
 */
function registeredTools(): RegisteredTool[] {
	const captured: RegisteredTool[] = [];
	const pi = {
		on: () => undefined,
		registerTool: (definition: RegisteredTool) => captured.push(definition),
		registerCommand: () => undefined,
	};

	registerPiJournal(pi as never);
	return captured;
}

/**
 * Property names of a registered tool's generated schema, in emitted order.
 *
 * @param name - Tool name to look up
 * @returns Property names as the model will see them
 * @throws {@link Error} If no tool with that name was registered
 */
function emittedPropertyOrder(name: string): string[] {
	const tool = registeredTools().find((definition) => definition.name === name);
	if (!tool) {
		throw new Error(`Tool "${name}" was not registered`);
	}
	return Object.keys(Value.Create(tool.parameters as never) as Record<string, unknown>);
}

describe("tool parameter ordering", () => {
	it("puts description first for edit", () => {
		expect(emittedPropertyOrder("edit")).toEqual(["description", "path", "oldText", "newText"]);
	});

	it("puts description first for write", () => {
		expect(emittedPropertyOrder("write")).toEqual(["description", "path", "content"]);
	});
});
