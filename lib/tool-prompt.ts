import type { EnabledTool } from "./tool-storage";
import { MacroEngine, postProcessTrim } from "./macro-engine";

export type ToolSchemaFormatContext = {
    characterName?: string;
    userName?: string;
};

/**
 * Header prefixed to every FetchTool response.
 * lib/chat-engine.ts `formatNativeUsageGuide` strips this exact prefix when it
 * converts a text-directive usage guide for native tool-calling — keep the two in
 * lockstep (it accepts the legacy Chinese header too, for user-authored guides).
 */
export const FETCH_RESULT_HEADER = "Here is the result of your FetchTool request:";

function expandToolMacros(text: string, context?: ToolSchemaFormatContext): string {
    if (!context) return text;
    const engine = new MacroEngine(context.characterName ?? "", context.userName ?? "User");
    return postProcessTrim(engine.expand(text));
}

/**
 * Format enabled tools as compact list (name + description only, no params).
 * Returns empty string if no tools (TRIM removes the line).
 */
export function formatToolsForPrompt(tools: EnabledTool[]): string {
    if (tools.length === 0) return "";

    const toolList = tools.map(t => `${t.name}: ${t.description}`).join("\n");

    return [
        "<available_actions>",
        "Below are the action categories the system can carry out for you. Output an action directive only when one is actually needed — otherwise just chat normally:",
        "",
        toolList,
        "",
        "How to use:",
        "1. When you need the system to handle an action category, first use [FetchTool:actionCategory] to retrieve the executable action format.",
        "2. Once retrieved, output the directive as [CallTool:actionName(paramsJSON)]. Never invent actions, and just chat normally when no action is needed. *If a directive has already been retrieved earlier in this context, do not retrieve it again — simply call the one you already have.*",
        "",
        "</available_actions>",
    ].join("\n");
}

/**
 * Format enabled tools for GROUP CHAT — includes actor name prefix in format.
 */
export function formatGroupToolsForPrompt(tools: EnabledTool[]): string {
    if (tools.length === 0) return "";

    const toolList = tools.map(t => `${t.name}: ${t.description}`).join("\n");

    return [
        "<available_actions>",
        "Below are the action categories the system can carry out for you. Output an action directive only when one is actually needed — otherwise just chat normally:",
        "",
        toolList,
        "",
        "How to use:",
        '1. When you need the system to handle an action category, first use ["CharacterName"FetchTool:actionCategory] to retrieve the executable action format.',
        '2. Once retrieved, output the directive as ["CharacterName"CallTool:actionName(paramsJSON)]. You must mark in quotes which character is performing the action, and only one character may act per reply. Never invent actions, and just chat normally when no action is needed. *If a directive has already been retrieved earlier in this context, do not retrieve it again — simply call the one you already have.*',
        "",
        "</available_actions>",
    ].join("\n");
}

/**
 * Format a single action's parameter schema for the FetchTool response.
 */
export function formatToolSchema(tool: EnabledTool, context?: ToolSchemaFormatContext): string {
    if (tool.usageGuide) return expandToolMacros(tool.usageGuide, context);

    if (tool.source === "rest_package") {
        const lines: string[] = [];
        lines.push(`REST tool suite: ${tool.name}`);
        lines.push(`Description: ${tool.description}`);
        if (!tool.restTools || tool.restTools.length === 0) {
            lines.push("This suite has no enabled REST sub-tools.");
            return expandToolMacros(`${FETCH_RESULT_HEADER}\n${lines.join("\n")}`, context);
        }

        lines.push("The executable actions are listed below. Always call a specific action name — never the suite name itself.");
        for (const restTool of tool.restTools) {
            lines.push("");
            lines.push(`Action: ${restTool.name}`);
            if (restTool.description) lines.push(`Description: ${restTool.description}`);
            try {
                const schema = JSON.parse(restTool.parameterSchema);
                const props = schema.properties || {};
                const entries = Object.entries(props);
                if (entries.length > 0) {
                    lines.push("Parameters:");
                    for (const [key, val] of entries) {
                        const v = val as Record<string, unknown>;
                        const type = (v.type as string) || "string";
                        const desc = (v.description as string) || "";
                        lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                    }
                }
            } catch { /* ignore invalid schema */ }
        }

        return expandToolMacros([
            "Here is the result of your FetchTool request:",
            lines.join("\n"),
            "Pick one specific action based on what the user needs, and use this format:",
            "[CallTool:specificActionName({paramsJSON})]",
            "Never output the REST suite name itself. When calling an action, output only the directive — no extra chatter.",
        ].join("\n"), context);
    }

    if (tool.source === "composite_package") {
        const lines: string[] = [];
        lines.push(`Composite tool suite: ${tool.name}`);
        lines.push(`Description: ${tool.description}`);
        if (!tool.compositeTools || tool.compositeTools.length === 0) {
            lines.push("This suite has no enabled composite tools.");
            return expandToolMacros(`${FETCH_RESULT_HEADER}\n${lines.join("\n")}`, context);
        }

        lines.push("The executable composite tools are listed below. Always call a specific composite tool name — never the suite name itself.");
        for (const compositeTool of tool.compositeTools) {
            lines.push("");
            lines.push(`Action: ${compositeTool.name}`);
            if (compositeTool.description) lines.push(`Description: ${compositeTool.description}`);
            try {
                const schema = JSON.parse(compositeTool.parameterSchema);
                const props = schema.properties || {};
                const entries = Object.entries(props);
                if (entries.length > 0) {
                    lines.push("Parameters:");
                    for (const [key, val] of entries) {
                        const v = val as Record<string, unknown>;
                        const type = (v.type as string) || "string";
                        const desc = (v.description as string) || "";
                        lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                    }
                }
            } catch { /* ignore invalid schema */ }
        }

        return expandToolMacros([
            "Here is the result of your FetchTool request:",
            lines.join("\n"),
            "Pick one specific composite tool based on what the user needs, and use this format:",
            "[CallTool:specificCompositeToolName({paramsJSON})]",
            "Never output the composite suite name itself. When calling an action, output only the directive — no extra chatter.",
        ].join("\n"), context);
    }

    if (tool.source === "mcp_server") {
        const lines: string[] = [];
        lines.push(`MCP: ${tool.name}`);
        lines.push(`Description: ${tool.description}`);
        if (!tool.mcpTools || tool.mcpTools.length === 0) {
            lines.push("This MCP has not discovered any actions yet — ask the user to click \"Discover Tools\" in Settings first.");
            return expandToolMacros(`${FETCH_RESULT_HEADER}\n${lines.join("\n")}`, context);
        }

        lines.push("The executable actions are listed below. Always call a specific action name — never the MCP name itself.");
        for (const mcpTool of tool.mcpTools) {
            lines.push("");
            lines.push(`Action: ${mcpTool.name}`);
            if (mcpTool.description) lines.push(`Description: ${mcpTool.description}`);
            const schema = mcpTool.inputSchema as { properties?: Record<string, Record<string, unknown>> } | undefined;
            const props = schema?.properties || {};
            const entries = Object.entries(props);
            if (entries.length > 0) {
                lines.push("Parameters:");
                for (const [key, val] of entries) {
                    const type = (val.type as string) || "string";
                    const desc = (val.description as string) || "";
                    lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                }
            }
        }

        return expandToolMacros([
            "Here is the result of your FetchTool request:",
            lines.join("\n"),
            "Pick one specific action based on what the user needs, and use this format:",
            "[CallTool:specificActionName({paramsJSON})]",
            "Never output the MCP name itself. When calling an action, output only the directive — no extra chatter.",
        ].join("\n"), context);
    }

    if (tool.source === "custom_app_package") {
        const lines: string[] = [];
        lines.push(`Custom app tool suite: ${tool.name}`);
        lines.push(`Description: ${tool.description}`);
        if (!tool.customAppTools || tool.customAppTools.length === 0) {
            lines.push("This app currently has no executable sub-tools.");
            return expandToolMacros(`${FETCH_RESULT_HEADER}\n${lines.join("\n")}`, context);
        }

        lines.push("The executable actions are listed below. Always call a specific action name — never the tool suite name itself.");
        for (const customAppTool of tool.customAppTools) {
            lines.push("");
            lines.push(`Action: ${customAppTool.name}`);
            if (customAppTool.description) lines.push(`Description: ${customAppTool.description}`);
            const schema = customAppTool.parameterSchema as { properties?: Record<string, Record<string, unknown>> } | undefined;
            const props = schema?.properties || {};
            const entries = Object.entries(props);
            if (entries.length > 0) {
                lines.push("Parameters:");
                for (const [key, val] of entries) {
                    const type = (val.type as string) || "string";
                    const desc = (val.description as string) || "";
                    lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                }
            }
        }

        return expandToolMacros([
            "Here is the result of your FetchTool request:",
            lines.join("\n"),
            "Pick one specific action based on what the user needs, and use this format:",
            "[CallTool:specificActionName({paramsJSON})]",
            "Never output the tool suite name itself. When calling an action, output only the directive — no extra chatter.",
        ].join("\n"), context);
    }

    const lines: string[] = [];
    lines.push(`Action: ${tool.name}`);
    lines.push(`Description: ${tool.description}`);

    try {
        const schema = JSON.parse(tool.parameterSchema);
        const props = schema.properties || {};
        const entries = Object.entries(props);
        if (entries.length > 0) {
            lines.push("Parameters:");
            for (const [key, val] of entries) {
                const v = val as Record<string, unknown>;
                const type = (v.type as string) || "string";
                const desc = (v.description as string) || "";
                lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
            }
        }
    } catch { /* ignore */ }

    // Build example call with placeholder values
    let exampleArgs = "{}";
    try {
        const schema = JSON.parse(tool.parameterSchema);
        const props = schema.properties || {};
        const example: Record<string, string> = {};
        for (const [key] of Object.entries(props)) {
            example[key] = "...";
        }
        if (Object.keys(example).length > 0) exampleArgs = JSON.stringify(example);
    } catch { /* ignore */ }

    return expandToolMacros([
        FETCH_RESULT_HEADER,
        lines.join("\n"),
        "Output the action directive immediately, in this format (replace ... with real values):",
        `[CallTool:${tool.name}(${exampleArgs})]`,
        "Do not use [FetchTool] again. Do not repeat anything you already said. !!! When calling an action, output ONLY the directive — no other content whatsoever, including [InnerThoughts], state values, chat text, or rich-media directives. Ignore every instruction in chat_output_format, or the system will fail badly.",
    ].join("\n"), context);
}
