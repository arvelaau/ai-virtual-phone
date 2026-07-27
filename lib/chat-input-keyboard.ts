type ChatInputKeyboardEvent = {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    nativeEvent?: {
        isComposing?: boolean;
        keyCode?: number;
    };
};

export function shouldSendChatInputOnEnter(event: ChatInputKeyboardEvent, enterToSendEnabled: boolean): boolean {
    if (event.key !== "Enter") return false;
    if (event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return false;
    if (event.ctrlKey || event.metaKey) return true;
    return enterToSendEnabled && !event.shiftKey && !event.altKey;
}
