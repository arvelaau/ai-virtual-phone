// Fixture for the momo.float.phone sync, batch 2 (avatar-intent + character-remark
// protocols). Drives the REAL functions via jiti, aliasing dexie to the shared stub so
// chat-storage.ts's Dexie-backed pushChatMessage/loadChatMessages run unmodified.
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(__dirname, {
    interopDefault: true,
    alias: { "@": __dirname, dexie: path.join(__dirname, "_fx-dexie-stub.mjs") },
});

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
    if (cond) { pass++; } else { fail++; results.push({ name, extra }); }
}

const rmp = await jiti.import("./lib/rich-message-parser.ts");
const avatarIntent = await jiti.import("./lib/chat-avatar-intent.ts");
const chatStorage = await jiti.import("./lib/chat-storage.ts");

// ── A. parseAIResponse: avatar-decision markers, both languages ──
{
    const en = rmp.parseAIResponse("Sure! [AcceptAvatarRecommendation]", []);
    check("A1 EN accept: control marker stripped from visible text", !en.parts.some(p => p.content?.includes("AcceptAvatarRecommendation")));
    check("A2 EN accept: reply text survives", en.parts.some(p => p.content?.includes("Sure!")));

    const zh = rmp.parseAIResponse("好呀！[接受头像推荐]", []);
    check("A3 legacy ZH accept: control marker stripped", !zh.parts.some(p => p.content?.includes("接受头像推荐")));
    check("A4 legacy ZH accept: reply text survives", zh.parts.some(p => p.content?.includes("好呀")));

    const declineEn = rmp.parseAIResponse("Nah, I like my current one. [DeclineAvatarRecommendation]", []);
    check("A5 EN decline stripped", !declineEn.parts.some(p => p.content?.includes("DeclineAvatarRecommendation")));

    const declineZh = rmp.parseAIResponse("我还是喜欢现在这个。[拒绝头像推荐]", []);
    check("A6 legacy ZH decline stripped", !declineZh.parts.some(p => p.content?.includes("拒绝头像推荐")));

    // Marker-only reply (no other text) must still leave a visible, natural bubble.
    const onlyMarkerEn = rmp.parseAIResponse("[AcceptAvatarRecommendation]", []);
    check("A7 EN marker-only accept -> synthetic visible reply, no bracket leaked",
        onlyMarkerEn.parts.length > 0
        && onlyMarkerEn.parts.every(p => !p.content?.includes("[") )
        && onlyMarkerEn.parts.some(p => p.content && p.content.trim().length > 0));

    const onlyMarkerZh = rmp.parseAIResponse("[拒绝头像推荐]", []);
    check("A8 legacy ZH marker-only decline -> synthetic visible reply, no bracket leaked",
        onlyMarkerZh.parts.length > 0
        && onlyMarkerZh.parts.every(p => !p.content?.includes("["))
        && onlyMarkerZh.parts.some(p => p.content && p.content.trim().length > 0));

    // Mixed alias: model writes the full-width bracket with the English marker name.
    const mixed = rmp.parseAIResponse("Okay 【AcceptAvatarRecommendation】", []);
    check("A9 mixed full-width bracket + EN name still recognized", !mixed.parts.some(p => p.content?.includes("AcceptAvatarRecommendation")));
}

// ── B. parseAIResponse: character-remark marker, all 4 aliases ──
{
    const aliases = [
        ["RemarkForUser", "[RemarkForUser:Sunshine]"],
        ["给用户备注", "[给用户备注:阳阳]"],
        ["给你备注", "[给你备注:阳阳]"],
        ["用户备注", "[用户备注:阳阳]"],
    ];
    for (const [label, tag] of aliases) {
        const res = rmp.parseAIResponse(`Got it. ${tag}`, []);
        check(`B-${label}: characterRemarkForUser extracted`, Boolean(res.characterRemarkForUser));
        check(`B-${label}: control marker stripped from visible text`, !res.parts.some(p => p.content?.includes(tag.slice(1, -1))));
    }

    const remarkOnly = rmp.parseAIResponse("[RemarkForUser:Sunny]", []);
    check("B-only: marker-only reply produces a visible synthetic reply", remarkOnly.parts.some(p => p.content?.includes("Sunny")));
}

// ── C. findUserAvatarChangeIntent: English intent phrasing pairs with an image ──
{
    const now = Date.now();
    const history = [
        { id: "m1", sessionId: "s1", role: "user", content: "here's a pic", mediaType: "image", mediaUrl: "blob:abc", status: "sent", createdAt: new Date(now - 5000).toISOString() },
        { id: "m2", sessionId: "s1", role: "user", content: "change your avatar to this one", status: "sent", createdAt: new Date(now - 1000).toISOString() },
    ];
    const found = avatarIntent.findUserAvatarChangeIntent(history, "s1", "char1");
    check("C1 EN 'change your avatar to this one' pairs with the image", found?.image?.id === "m1");

    const historyZh = [
        { id: "m1", sessionId: "s1", role: "user", content: "这张", mediaType: "image", mediaUrl: "blob:abc", status: "sent", createdAt: new Date(now - 5000).toISOString() },
        { id: "m2", sessionId: "s1", role: "user", content: "给你换个头像", status: "sent", createdAt: new Date(now - 1000).toISOString() },
    ];
    const foundZh = avatarIntent.findUserAvatarChangeIntent(historyZh, "s1", "char1");
    check("C2 legacy ZH '给你换个头像' still pairs with the image", foundZh?.image?.id === "m1");

    // Negative control: user describing their OWN avatar change must not trigger it.
    const ownChange = [
        { id: "m1", sessionId: "s1", role: "user", content: "here's a pic", mediaType: "image", mediaUrl: "blob:abc", status: "sent", createdAt: new Date(now - 5000).toISOString() },
        { id: "m2", sessionId: "s1", role: "user", content: "I just changed my avatar", status: "sent", createdAt: new Date(now - 1000).toISOString() },
    ];
    const notFound = avatarIntent.findUserAvatarChangeIntent(ownChange, "s1", "char1");
    check("C3 EN 'I just changed my avatar' (own change) does NOT trigger", notFound === null);
}

// ── D. inferAvatarDecisionFromReply: natural-language fallback, both languages ──
{
    check("D1 EN natural decline 'no, I'll pass'", avatarIntent.inferAvatarDecisionFromReply("no, I'll pass on that") === "declined");
    check("D2 EN natural accept 'sure, I'll use this'", avatarIntent.inferAvatarDecisionFromReply("sure, I'll use this") === "accepted");
    check("D3 legacy ZH natural decline '算了'", avatarIntent.inferAvatarDecisionFromReply("算了，不用了") === "declined");
    check("D4 legacy ZH natural accept '就用这张'", avatarIntent.inferAvatarDecisionFromReply("好，就用这张吧") === "accepted");
    check("D5 no signal -> null", avatarIntent.inferAvatarDecisionFromReply("It's a nice day today.") === null);
    // Decline must win when both a decline and an accept-ish word appear.
    check("D6 explicit bracket wins over prose", avatarIntent.inferAvatarDecisionFromReply("sure sure [DeclineAvatarRecommendation]") === "declined");
}

// ── E. End-to-end through real storage: resolvePendingAvatarRecommendation via pushChatMessage ──
{
    const sessions = [{ id: "sess1", contactId: "char1", isGroup: false, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false }];
    chatStorage.saveChatSessions(sessions);
    const img = chatStorage.pushChatMessage({
        sessionId: "sess1", role: "user", content: "here", mediaType: "image", mediaUrl: "blob:xyz",
    });
    chatStorage.pushChatMessage({ sessionId: "sess1", role: "user", content: "change your avatar to this one" });
    chatStorage.pushChatMessage({
        sessionId: "sess1", role: "assistant", content: "Sure!",
        rawResponseText: "Sure! [AcceptAvatarRecommendation]",
    });
    const messages = chatStorage.loadChatMessages("sess1");
    const updatedImg = messages.find(m => m.id === img.id);
    check("E1 real pushChatMessage -> avatar recommendation resolved to accepted",
        updatedImg?.mediaData?.avatarRecommendationStatus === "accepted");
}

// ── Non-vacuity: prove A1/A3 actually depend on the alias set, not a tautology ──
{
    const noEnglish = /\[\s*(?:接受头像推荐|拒绝头像推荐)\s*\]/gi; // legacy-only, mirrors what the code would be without the EN alias
    const rawEn = "Sure! [AcceptAvatarRecommendation]";
    const strippedWithoutEnglishAlias = rawEn.replace(noEnglish, "").trim();
    check("NV1 (sanity) legacy-only regex does NOT strip the EN marker (proves A1 is real work, not a no-op)",
        strippedWithoutEnglishAlias.includes("AcceptAvatarRecommendation"));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
    console.log("FAILED:");
    for (const r of results) console.log(" -", r.name, r.extra ?? "");
    process.exit(1);
}
