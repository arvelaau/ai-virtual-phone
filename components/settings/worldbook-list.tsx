"use strict";

import { useMemo, useState } from "react";
import type { WorldBookEntry } from "@/lib/settings-types";

interface WorldbookListProps {
    entries: Record<string, WorldBookEntry>;
}

export function WorldbookList({ entries }: WorldbookListProps) {
    const list = useMemo(() => Object.values(entries), [entries]);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    if (list.length === 0) {
        return (
            <div className="ui-empty">
                <span className="menu-desc">No worldbook entries yet</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4 p-4 pb-20">
            {list.map((entry) => (
                <div
                    key={entry.uid}
                    className="ui-list-card-expandable"
                >
                    <div
                        className="p-4 flex flex-col gap-2 cursor-pointer"
                        onClick={() => setExpandedId(expandedId === entry.uid ? null : entry.uid)}
                    >
                        <div className="flex justify-between items-start">
                            <span className="menu-label font-medium line-clamp-1">
                                {entry.comment || "Untitled entry"}
                            </span>
                            <span className="ui-badge" data-variant={entry.disable ? "muted" : "success"}>
                                {entry.disable ? "Disabled" : "Enabled"}
                            </span>
                        </div>

                        <div className="flex flex-wrap gap-1">
                            {entry.key ? entry.key.split(',').map((k, i) => (
                                <span key={i} className="ui-tag">
                                    {k.trim()}
                                </span>
                            )) : null}
                        </div>
                    </div>

                    {expandedId === entry.uid && (
                        <div className="ui-collapsible-body">
                            <div className="mt-3 flex flex-col gap-2">
                                <span className="menu-desc font-mono !ts-11">UID: {entry.uid}</span>
                                <pre className="ui-code-block max-h-60 m-0">
                                    {entry.content}
                                </pre>
                                <div className="menu-desc flex gap-4 pt-2">
                                    <span>Weight: {entry.insertion_order}</span>
                                    <span>Probability: {entry.probability}%</span>
                                    <span>Position: {entry.position}</span>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
