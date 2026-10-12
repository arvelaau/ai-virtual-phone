import { saveChatImageToIndexedDB } from "./chat-asset-storage";
import { syncChatGeneratedImagePromptText, updateChatMessage, type ChatMessage } from "./chat-storage";
import { generatedImageFilename, generateImageFromConfiguredApi } from "./image-generation-service";
import { updateMomentPost } from "./moments-storage";
import type { MomentPost } from "./moments-types";

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function dispatchChatMessagesUpdated(sessionId: string, message: ChatMessage): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("chat-messages-updated", {
        detail: { sessionId, message },
    }));
}

function dispatchMomentsUpdated(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("moments-updated"));
}

export function createPendingChatGeneratedImageData(
    mediaData: ChatMessage["mediaData"] | undefined,
    description?: string,
): ChatMessage["mediaData"] {
    const label = (description || mediaData?.label || "").trim();
    return {
        ...mediaData,
        label,
        imageGenerationStatus: "pending",
        imageGenerationError: undefined,
    };
}

export function isPendingChatGeneratedImageMessage(message: Pick<ChatMessage, "mediaType" | "mediaData">): boolean {
    return message.mediaType === "image" && message.mediaData?.imageGenerationStatus === "pending";
}

export async function generateAndApplyChatGeneratedImage(
    message: ChatMessage,
    characterId?: string,
    options?: { signal?: AbortSignal; description?: string; useReferenceImage?: boolean },
): Promise<ChatMessage> {
    const previousDescription = message.mediaData?.label?.trim() || "";
    const description = (options?.description ?? previousDescription).trim();
    if (!description) throw new Error("Missing image description, can't regenerate");

    const effectiveUseReference = options?.useReferenceImage !== undefined
        ? options.useReferenceImage
        : (message.mediaData?.useReferenceImage === true);

    if (
        (previousDescription && previousDescription !== description) ||
        (options?.useReferenceImage !== undefined && options.useReferenceImage !== (message.mediaData?.useReferenceImage === true))
    ) {
        syncChatGeneratedImagePromptText(message.id, previousDescription, description, options?.useReferenceImage);
    }

    // Retry path: mark pending and broadcast first, so the bubble flips to "generating" right
    // away (the very first generation is already pending by construction, so no rewrite is
    // needed there). Either success or failure writes the status again afterward, so it never
    // gets stuck on pending.
    if (message.mediaData?.imageGenerationStatus !== "pending") {
        const marked = updateChatMessage(message.id, {
            mediaData: {
                ...message.mediaData,
                label: description,
                useReferenceImage: effectiveUseReference,
                imageGenerationStatus: "pending",
                imageGenerationError: undefined,
            },
        });
        if (marked) dispatchChatMessagesUpdated(marked.sessionId, marked);
    }

    try {
        const generated = await generateImageFromConfiguredApi({
            description,
            characterId,
            appId: "chat",
            useReferenceImage: effectiveUseReference,
            photoStyle: true,
            signal: options?.signal,
        });
        if (!generated) throw new Error("Image generation is not enabled or is incomplete");

        const fileName = generatedImageFilename(description, generated.mimeType);
        const previousData = message.mediaData ?? {};
        const nextData: ChatMessage["mediaData"] = {
            ...previousData,
            label: description,
            fileType: "image",
            fileName,
            useReferenceImage: effectiveUseReference,
            imageGenerationMediaRef: generated.mediaRef,
            imageGenerationPrompt: generated.prompt,
            imageGenerationUsedReference: generated.usedReferenceImage,
            imageGenerationStatus: "generated",
            imageGenerationError: undefined,
        };
        const updated = updateChatMessage(message.id, {
            content: fileName,
            mediaType: "media_file",
            mediaUrl: generated.dataUrl,
            mediaData: nextData,
        });
        if (!updated) throw new Error("The original message no longer exists, can't replace the image");
        dispatchChatMessagesUpdated(updated.sessionId, updated);
        return updated;
    } catch (error) {
        const failed = updateChatMessage(message.id, {
            mediaData: {
                ...message.mediaData,
                label: description,
                useReferenceImage: effectiveUseReference,
                imageGenerationStatus: "failed",
                imageGenerationError: errorToMessage(error),
            },
        });
        if (failed) dispatchChatMessagesUpdated(failed.sessionId, failed);
        throw error;
    }
}

export async function retryChatGeneratedImage(
    message: ChatMessage,
    characterId?: string,
    nextDescription?: string,
    useReferenceImage?: boolean,
): Promise<ChatMessage> {
    return generateAndApplyChatGeneratedImage(message, characterId, {
        description: nextDescription,
        useReferenceImage,
    });
}

export async function retryMomentGeneratedPhoto(
    post: MomentPost,
    nextDescription?: string,
    useReferenceImage?: boolean,
): Promise<MomentPost> {
    const description = (nextDescription ?? post.photoDescription)?.trim();
    if (!description) throw new Error("Missing image description, can't regenerate");

    const effectiveUseReference = useReferenceImage !== undefined
        ? useReferenceImage
        : (post.photoUseReferenceImage === true);

    // Same as chat: mark pending and broadcast first, so the card shows "generating image…"
    // right away; either success or failure writes the status again afterward.
    updateMomentPost(post.id, {
        photoDescription: description,
        photoUseReferenceImage: effectiveUseReference,
        photoGenerationStatus: "pending",
        photoGenerationError: undefined,
    });
    dispatchMomentsUpdated();

    try {
        const generated = await generateImageFromConfiguredApi({
            description,
            characterId: post.authorType === "character" ? post.authorId : undefined,
            appId: "moments",
            useReferenceImage: effectiveUseReference,
            photoStyle: true,
        });
        if (!generated) throw new Error("Image generation is not enabled or is incomplete");

        const assetId = await saveChatImageToIndexedDB(generated.blob);
        const updated = updateMomentPost(post.id, {
            photoUrl: `asset://${assetId}`,
            photoDescription: description,
            photoUseReferenceImage: effectiveUseReference,
            photoGenerationStatus: "generated",
            photoGenerationPrompt: generated.prompt,
            photoGenerationError: undefined,
        });
        if (!updated) throw new Error("The original Moments post no longer exists, can't replace the image");
        dispatchMomentsUpdated();
        return updated;
    } catch (error) {
        updateMomentPost(post.id, {
            photoDescription: description,
            photoUseReferenceImage: effectiveUseReference,
            photoGenerationStatus: "failed",
            photoGenerationError: errorToMessage(error),
        });
        dispatchMomentsUpdated();
        throw error;
    }
}
