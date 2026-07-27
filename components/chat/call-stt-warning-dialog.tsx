"use client";

const CALL_STT_WARNING_HIDDEN_KEY = "ai_phone_call_stt_warning_hidden_v1";

export function isCallSttWarningHidden(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return window.localStorage.getItem(CALL_STT_WARNING_HIDDEN_KEY) === "1";
    } catch {
        return false;
    }
}

export function hideCallSttWarningPermanently() {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(CALL_STT_WARNING_HIDDEN_KEY, "1");
    } catch {
        // Ignore storage failures; the prompt can still be closed for this session.
    }
}

type CallSttWarningDialogProps = {
    title?: string;
    message?: string;
    onClose: () => void;
    onNeverShow: () => void;
};

export function CallSttWarningDialog({
    title = "Voice Recognition Notice",
    message = "No recognizable speech was detected. Your browser may not support speech recognition, the microphone permission may be off, or the microphone may have no input. Tap the microphone button in the middle to switch to text input and continue the call.",
    onClose,
    onNeverShow,
}: CallSttWarningDialogProps) {
    return (
        <div className="modal-overlay" role="presentation" onClick={onClose}>
            <div
                className="modal-dialog call-stt-warning-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="call-stt-warning-title"
                onClick={event => event.stopPropagation()}
            >
                <div className="modal-header">
                    <h3 id="call-stt-warning-title" className="modal-title">{title}</h3>
                </div>
                <div className="modal-body">
                    <p>{message}</p>
                </div>
                <div className="modal-footer">
                    <button type="button" className="ui-btn ui-btn-ghost" onClick={onClose}>Got it</button>
                    <button type="button" className="ui-btn ui-btn-primary" onClick={onNeverShow}>Don't show again</button>
                </div>
            </div>
        </div>
    );
}
