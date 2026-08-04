"use client";

// components/chat-plugin-bootstrap.tsx
// Chat plugin runtime bootstrap: loads all enabled plugins once the app mounts.
// Placed in the root layout so plugin hooks are registered before the user enters chat.

import { useEffect } from "react";
import { getChatPluginRuntime } from "@/lib/chat-plugin-runtime";

export function ChatPluginBootstrap() {
    useEffect(() => {
        void getChatPluginRuntime().ensureStarted();
    }, []);
    return null;
}
