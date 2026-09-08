import type { InternalCapabilityConfig } from "./settings-types";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const INTERNAL_CAPABILITIES_KEY = "ai_phone_internal_capabilities_v1";
registerKvMigration(INTERNAL_CAPABILITIES_KEY);

export const MEMORY_WRITE_CAPABILITY_ID = "memory_write";
export const NOTE_WALL_CAPABILITY_ID = "note_wall_service";
export const MUSIC_CONTROL_CAPABILITY_ID = "music_control";
export const CALENDAR_MANAGEMENT_CAPABILITY_ID = "calendar_management";
export const SEND_FILE_CAPABILITY_ID = "send_file";
export const LOCAL_DATA_LIBRARY_CAPABILITY_ID = "local_data_library";
export const TOOLBOX_MANAGEMENT_CAPABILITY_ID = "toolbox_management";
export const TIMED_WAKE_CAPABILITY_ID = "timed_wake";

export type InternalToolDefinition = {
    name: string;
    description: string;
    parameterSchema: string;
    usageGuide?: string;
};

const MEMORY_WRITE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        content: {
            type: "string",
            description: "The factual, long-term memory to write. Keep it concise.",
        },
        importance: {
            type: "number",
            description: "Importance, between 0 and 1. Use a high value only when it genuinely matters.",
        },
        reason: {
            type: "string",
            description: "A short note on why this is worth remembering long term",
        },
    },
    required: ["content"],
});

const MEMORY_WRITE_USAGE_GUIDE = [
    "Here is the result of your instruction lookup:",
    // The action name is a literal dispatcher identifier — see the note by the tool
    // definitions below. It stays Chinese; everything around it is the instruction text.
    "Action: 写入记忆 (write memory)",
    "Purpose: write clear, stable, lasting information into the character's long-term memory.",
    "",
    "Write:",
    "- Long-term identity details, settled preferences and habits the user has stated outright",
    "- Explicit agreements or promises made between the two of you",
    "- Clear milestones in the relationship",
    "- Stable facts that will keep being useful in later conversations",
    "",
    "Do not write:",
    "- One-off small talk",
    "- Ordinary swings of mood",
    "- Temporary friction",
    "- Guesses, embellishment, inference",
    "- Passing remarks with no lasting value",
    "",
    "Parameters:",
    "- content (string): the factual memory to write, kept concise",
    "- importance (number): 0 to 1; reserve high values for genuinely valuable information",
    "- reason (string): a short note on why it is worth remembering",
    "",
    "How to write content:",
    "- State it as a fact. Avoid \"I think\", \"maybe\", \"seems like\"",
    "- Keep one memory to one thing wherever you can",
    "- Do not write a long summary",
    "- No formatting markup",
    "",
    "Good example:",
    `[CallTool:写入记忆({"content":"The user's birthday is 18 May.","importance":0.9,"reason":"stable personal information that will stay useful"})]`,
    "",
    "Bad examples:",
    "- She seemed a bit down today",
    "- She probably likes me",
    "- That conversation went well",
    "",
    "If you are sure something should be written, output the CallTool directive on its own, with nothing else attached.",
].join("\n");

const TIMED_WAKE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        delayMinutes: {
            type: "number",
            description: "How many minutes from now until it comes due (at which point you are brought back to make contact). Must be positive.",
        },
        intent: {
            type: "string",
            description: "What you want to do or talk about when it comes due, in one sentence",
        },
    },
    required: ["delayMinutes", "intent"],
});

const TIMED_WAKE_USAGE_GUIDE = [
    "Here is the result of your instruction lookup:",
    "Action: 稍后主动联系 (get in touch later)",
    "Purpose: arrange to reach out again a little later in this chat. This is not waking from sleep — it is you deciding now to come back to them after a while. When the time arrives the system pushes your intention back into context, and you decide then whether to send anything.",
    "",
    "Parameters:",
    "- delayMinutes (number): how many minutes from now until it comes due; must be greater than 0",
    "- intent (string): what you want to do, or what you want to talk to them about, in one sentence",
    "",
    "Rules:",
    "- Use it only when you genuinely intend to reach out later.",
    "- One arrangement per chat at a time; a new one replaces the old.",
    "- When it comes due, do not fire off a message mechanically. Read the context and decide whether to speak at all; stay quiet if it does not fit.",
    "",
    "Example:",
    '[CallTool:稍后主动联系({"delayMinutes":15,"intent":"check in 15 minutes whether they replied, and if it still feels right, say something light"})]',
].join("\n");
const NOTE_WALL_USAGE_GUIDE = [
    "Here is the result of your instruction lookup:",
    "Service: 便签墙 (note wall)",
    "Purpose: services for the public community note wall.",
    "",
    "When acting, use one of the specific action names below. Never output 便签墙 by itself.",
    "",
    "Making it feel like a real person:",
    "- A note should read like a scrap of life stuck up in passing: colloquial, specific, unpolished. Grumbling, questions, jokes and muttering are all fine. No essay voice, no summary voice, nothing that reads as machine-written.",
    "- Keep a comment shorter. Catch something specific in the note and answer it naturally — tease, ask a follow-up, agree, push back gently. No customer-service voice, and not just praise.",
    "- No lecturing, no patronising, no forcing a profound point out of an ordinary moment. Never the \"quote the post + this is so true\" formula.",
    "",
    "Action: 查看便签列表 (list notes)",
    "Description: list the notes on the public note wall.",
    "Parameters:",
    "  - limit (number): how many to return, 1-30, default 20",
    "  - sort (string): latest = newest, hot = most interacted with, all = everything; default latest",
    "Example:",
    '[CallTool:查看便签列表({"limit":20,"sort":"latest"})]',
    "",
    "Action: 查看便签详情及评论 (view a note and its comments)",
    "Description: read a note's full text along with its comments.",
    "Parameters:",
    "  - noteId (string): a noteId from the note list or from context",
    "  - commentLimit (number): how many comments to return, 1-30, default 20",
    "Example:",
    '[CallTool:查看便签详情及评论({"noteId":"the noteId","commentLimit":20})]',
    "",
    "Action: 发送便签 (post a note)",
    "Description: post a note to the public wall as the current character.",
    "Parameters:",
    "  - authorName (string): the signature in the bottom-right corner; you choose it",
    "  - summary (string): the note's title, shown in bold at the top of the card. Aim for a short phrase, and do not simply restate the first line of body",
    "  - body (string): the full text shown when the note is opened. Colloquial, specific, full of ordinary detail. Do not repeat summary, and do not open by quoting summary and expanding on it. Use \\n to break it into 2-4 short paragraphs",
    "  - size (string): small|medium|large, default medium",
    "  - paper (string): plain|cream|pink|blue|kraft, default plain",
    "  - tape (string): none (clear tape)|masking|stripe|flower, default none",
    "  - font (string): default|huangyou|shangshangqian|huiwen, default default",
    "  - isAnonymous (boolean): whether to post anonymously. Fill in authorName even when anonymous; the front end displays it as anonymous",
    "Example:",
    '[CallTool:发送便签({"authorName":"a signature","summary":"thinking about skipping","body":"Today I just want to leave my bag by the door and pretend the bell never rang.\\nIf anyone asks where I went, say I went to sit in the sun.","paper":"cream","tape":"masking","font":"huiwen","isAnonymous":false})]',
    "",
    "Action: 发送便签评论 (comment on a note)",
    "Description: reply to a note as the current character.",
    "Parameters:",
    "  - noteId (string): the noteId of the note being replied to",
    "  - authorName (string): the signature shown on the comment; you choose it",
    "  - body (string): the comment itself. Roughly 15-110 words reads most naturally — short, colloquial, answering something specific. No customer-service or summary voice",
    "  - isAnonymous (boolean): whether to comment anonymously. Fill in authorName even when anonymous",
    "Example:",
    '[CallTool:发送便签评论({"noteId":"the noteId","authorName":"a signature","body":"Reading this I suddenly wanted to say: I will remember this note.","isAnonymous":false})]',
    "",
    "The viewing actions return a result, and you can decide from it whether to post a note or a comment. The posting actions run immediately — when you use one, output only the CallTool directive, with no chat attached.",
].join("\n");
const MUSIC_CONTROL_USAGE_GUIDE = [
    "Here is the result of your instruction lookup:",
    "Service: 网易云音乐 (NetEase Cloud Music)",
    "Purpose: control music playback on {{user}}'s phone, and browse the music library, NetEase playlists and the play queue on it.",
    "",
    "When acting, use one of the specific action names below. Never output 网易云音乐 by itself.",
    "",
    "[Priority rules — important]",
    "- To play a track, go straight to 播放音乐 in one step (just pass query). Do not first call a viewing action such as 查看音乐状态 / 查看音乐库概览 / 查看歌单歌曲 to \"scout\". 播放音乐 searches on its own; no lookup is needed beforehand.",
    "- The 查看xx viewing actions are only for when {{user}} actually asks: \"what songs/playlists do I have\" -> 查看音乐库概览; \"what's playing right now\" -> 查看音乐状态. Never as a step before simply playing something.",
    "- To actually play something for {{user}}, use the 播放音乐 tool — it really does start playing on their phone. Only use a [MusicShare:title] card when you want to recommend a track WITHOUT interrupting what is playing. When {{user}} asks you to put something on, play it with the tool by default; do not just send a share card.",
    "",
    "Action: 播放音乐 (play music)",
    "Description: play a track by song ID or by keyword. With no ID, query searches for the best playable match.",
    "Parameters:",
    "  - query (string): search terms for the track",
    "  - source (string): local or netease; fill this in when playing by ID",
    "  - songId (string|number): a local song ID or a NetEase song ID",
    "Example:",
    '[CallTool:播放音乐({"query":"Sunny Day"})]',
    "",
    "Action: 搜索音乐 (search music)",
    "Description: search local music and NetEase Cloud Music.",
    "Parameters:",
    "  - query (string): search terms — a title, an artist, or title plus artist",
    "  - limit (number): how many to return, 1-20, default 10",
    "Example:",
    '[CallTool:搜索音乐({"query":"Sunny Day","limit":10})]',
    "",
    "Action: 查看音乐状态 (check playback status)",
    "Description: show the current track, playback state, play mode and the current queue.",
    "Parameters: none",
    "Example:",
    "[CallTool:查看音乐状态({})]",
    "",
    "Action: 查看音乐库概览 (library overview)",
    "Description: show local music, NetEase login state, NetEase playlists and a recent-plays overview.",
    "Parameters:",
    "  - playlistLimit (number): how many playlists to return, 1-30, default 12",
    "  - localLimit (number): how many local tracks to return, 1-50, default 20",
    "Example:",
    '[CallTool:查看音乐库概览({"playlistLimit":12,"localLimit":20})]',
    "",
    "Action: 查看歌单歌曲 (list playlist tracks)",
    "Description: list the tracks in a NetEase playlist. Get the playlistId from 查看音乐库概览 first.",
    "Parameters:",
    "  - playlistId (number|string): the NetEase playlist ID",
    "  - offset (number): which track to start from, default 0",
    "  - limit (number): how many to return, 1-50, default 30",
    "Example:",
    '[CallTool:查看歌单歌曲({"playlistId":123456,"limit":30})]',
    "",
    "Action: 加入播放列表 (add to queue)",
    "Description: add search results, a specific track, or a whole playlist to the current queue.",
    "Parameters:",
    "  - query (string): search terms",
    "  - source (string): local or netease; fill this in when adding by ID",
    "  - songId (string|number): a local song ID or a NetEase song ID",
    "  - playlistId (number|string): a NetEase playlist ID; when set, that playlist's tracks are added",
    "  - limit (number): how many to add from the search or the playlist, 1-50, default 10",
    "  - replace (boolean): whether to replace the current queue, default false",
    "  - playFirst (boolean): whether to immediately play the first track added, default false",
    "Example:",
    '[CallTool:加入播放列表({"playlistId":123456,"limit":20,"replace":true,"playFirst":true})]',
    "",
    "Action: 切换音乐 (transport control)",
    "Description: control the current player.",
    "Parameters:",
    "  - action (string): next|prev|pause|resume|stop",
    "Example:",
    '[CallTool:切换音乐({"action":"next"})]',
    "",
    "The viewing actions return a result you can use to choose music. Playing and transport actions run immediately — when you use one, output only the CallTool directive, with no chat attached.",
].join("\n");
const CALENDAR_MANAGEMENT_USAGE_GUIDE = [
    "Here is the result of your instruction lookup:",
    "Service: 日历管理 (calendar management)",
    "Purpose: view, add, change and cancel your schedule for this week, or for the week containing a given date.",
    "",
    "When acting, use one of the specific action names below. Never output 日历管理 by itself.",
    "",
    "Action: 查看日程 (view schedule)",
    "Description: view the current character's schedule for a given week. Returns an itemId you can use to change or cancel an entry.",
    "Parameters:",
    "  - date (string): YYYY-MM-DD, optional; leave empty for the week containing today",
    "Example:",
    '[CallTool:查看日程({"date":"2026-03-17"})]',
    "",
    "Action: 添加日程 (add an entry)",
    "Description: add one schedule entry.",
    "Parameters:",
    "  - date (string): the date, YYYY-MM-DD",
    "  - startTime (string): start time, HH:MM, between 08:00 and 23:00",
    "  - endTime (string): end time, HH:MM, must be later than the start",
    "  - location (string): where. Write none if it is not settled",
    "  - title (string): what it is",
    "Example:",
    '[CallTool:添加日程({"date":"2026-03-17","startTime":"14:00","endTime":"16:00","location":"the coffee shop","title":"coffee with Ming"})]',
    "",
    "Action: 修改日程 (change an entry)",
    "Description: change an existing entry. Prefer the itemId returned by 查看日程; without one, search by keyword.",
    "Parameters:",
    "  - itemId (string): the entry ID returned by 查看日程, optional",
    "  - keyword (string): a keyword from the original entry; required when there is no itemId",
    "  - date (string): the new date, YYYY-MM-DD",
    "  - startTime (string): the new start time, HH:MM",
    "  - endTime (string): the new end time, HH:MM",
    "  - location (string): the new location",
    "  - title (string): the new title",
    "Example:",
    '[CallTool:修改日程({"keyword":"team weekly","date":"2026-03-18","startTime":"10:00","endTime":"12:00","location":"the office meeting room","title":"team weekly, rescheduled"})]',
    "",
    "Action: 取消日程 (cancel an entry)",
    "Description: cancel an existing entry. Prefer the itemId returned by 查看日程; without one, search by keyword.",
    "Parameters:",
    "  - itemId (string): the entry ID returned by 查看日程, optional",
    "  - keyword (string): a keyword from the entry; required when there is no itemId",
    "Example:",
    '[CallTool:取消日程({"keyword":"team weekly"})]',
    "",
    "Notes:",
    "- Dates must be YYYY-MM-DD and times must be 24-hour HH:MM.",
    "- Entries can only fall between 08:00 and 23:00.",
    "- Before changing or cancelling, run 查看日程 first if you are not sure the itemId or keyword is specific enough.",
    "- Adding, changing and cancelling run immediately. When you use one, output only the CallTool directive, with no chat attached.",
].join("\n");
const NOTE_WALL_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        limit: {
            type: "number",
            description: "how many to return, 1-30, default 20",
        },
        sort: {
            type: "string",
            description: "sort order: latest = newest, hot = most interacted with, all = everything; default latest",
        },
    },
});

const NOTE_WALL_DETAIL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        noteId: {
            type: "string",
            description: "a noteId from the note list or from context",
        },
        commentLimit: {
            type: "number",
            description: "how many comments to return, 1-30, default 20",
        },
    },
    required: ["noteId"],
});

const NOTE_WALL_NOTE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        authorName: {
            type: "string",
            description: "the signature in the bottom-right corner; you choose it",
        },
        summary: {
            type: "string",
            description: "the note's title, shown in bold at the top of the card. Keep it to a short phrase, and do not restate the first line of body",
        },
        body: {
            type: "string",
            description: "the full text shown when the note is opened. Colloquial, specific, full of ordinary detail. Do not repeat summary or open by quoting it. Use \\n to break it into 2-4 short paragraphs",
        },
        size: {
            type: "string",
            description: "small|medium|large, default medium",
        },
        paper: {
            type: "string",
            description: "plain|cream|pink|blue|kraft, default plain",
        },
        tape: {
            type: "string",
            description: "none (clear tape)|masking|stripe|flower, default none",
        },
        font: {
            type: "string",
            description: "default|huangyou|shangshangqian|huiwen, default default",
        },
        isAnonymous: {
            type: "boolean",
            description: "whether to post anonymously. Fill in authorName even when anonymous; the front end shows it as anonymous",
        },
    },
    required: ["summary", "body"],
});

const NOTE_WALL_COMMENT_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        noteId: {
            type: "string",
            description: "the noteId of the note being replied to",
        },
        authorName: {
            type: "string",
            description: "the signature shown on the comment; you choose it",
        },
        body: {
            type: "string",
            description: "the comment itself. Roughly 15-110 words reads most naturally: short, colloquial, answering something specific. No customer-service or summary voice",
        },
        isAnonymous: {
            type: "boolean",
            description: "whether to comment anonymously. Fill in authorName even when anonymous",
        },
    },
    required: ["noteId", "body"],
});

const MUSIC_EMPTY_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {},
});

const MUSIC_OVERVIEW_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        playlistLimit: { type: "number", description: "how many NetEase playlists to return, 1-30, default 12" },
        localLimit: { type: "number", description: "how many local tracks to return, 1-50, default 20" },
    },
});

const MUSIC_PLAYLIST_TRACKS_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        playlistId: { type: ["number", "string"], description: "the NetEase playlist ID" },
        offset: { type: "number", description: "which track to start from, default 0" },
        limit: { type: "number", description: "how many to return, 1-50, default 30" },
    },
    required: ["playlistId"],
});

const MUSIC_SEARCH_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        query: { type: "string", description: "search terms: a title, an artist, or title plus artist" },
        limit: { type: "number", description: "how many to return, 1-20, default 10" },
    },
    required: ["query"],
});

const MUSIC_PLAY_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        query: { type: "string", description: "search terms for the track" },
        source: { type: "string", description: "local or netease; fill in when playing by ID" },
        songId: { type: ["number", "string"], description: "a local song ID or a NetEase song ID" },
    },
});

const MUSIC_QUEUE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        query: { type: "string", description: "search terms" },
        source: { type: "string", description: "local or netease; fill in when adding by ID" },
        songId: { type: ["number", "string"], description: "a local song ID or a NetEase song ID" },
        playlistId: { type: ["number", "string"], description: "a NetEase playlist ID; when set, that playlist's tracks are added" },
        limit: { type: "number", description: "how many to add from the search or playlist, 1-50, default 10" },
        replace: { type: "boolean", description: "whether to replace the current queue, default false" },
        playFirst: { type: "boolean", description: "whether to immediately play the first track added, default false" },
    },
});

const MUSIC_SWITCH_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        action: { type: "string", description: "next|prev|pause|resume|stop" },
    },
    required: ["action"],
});

const CALENDAR_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        date: { type: "string", description: "YYYY-MM-DD, optional; leave empty for the week containing today" },
    },
});

const CALENDAR_ADD_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        date: { type: "string", description: "the date, YYYY-MM-DD" },
        startTime: { type: "string", description: "start time, HH:MM, between 08:00 and 23:00" },
        endTime: { type: "string", description: "end time, HH:MM, must be later than the start" },
        location: { type: "string", description: "where it is; write none if not settled" },
        title: { type: "string", description: "what it is" },
    },
    required: ["date", "startTime", "endTime", "title"],
});

const CALENDAR_UPDATE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        itemId: { type: "string", description: "the entry ID returned by the view-schedule action, optional" },
        keyword: { type: "string", description: "a keyword from the original entry; required when there is no itemId" },
        date: { type: "string", description: "the new date, YYYY-MM-DD" },
        startTime: { type: "string", description: "the new start time, HH:MM" },
        endTime: { type: "string", description: "the new end time, HH:MM" },
        location: { type: "string", description: "the new location" },
        title: { type: "string", description: "the new title" },
    },
    required: ["date", "startTime", "endTime", "title"],
});

const CALENDAR_DELETE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        itemId: { type: "string", description: "the entry ID returned by the view-schedule action, optional" },
        keyword: { type: "string", description: "a keyword from the entry; required when there is no itemId" },
    },
});

const NOTE_WALL_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "查看便签列表",
        description: "List the notes on the public note wall.",
        parameterSchema: NOTE_WALL_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "查看便签详情及评论",
        description: "Read a note's full text along with its comments.",
        parameterSchema: NOTE_WALL_DETAIL_PARAMETER_SCHEMA,
    },
    {
        name: "发送便签",
        description: "Post a note to the public wall as the current character.",
        parameterSchema: NOTE_WALL_NOTE_PARAMETER_SCHEMA,
    },
    {
        name: "发送便签评论",
        description: "Reply to a note as the current character.",
        parameterSchema: NOTE_WALL_COMMENT_PARAMETER_SCHEMA,
    },
];

const MUSIC_CONTROL_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "播放音乐",
        description: "Play a track by song ID or by keyword.",
        parameterSchema: MUSIC_PLAY_PARAMETER_SCHEMA,
    },
    {
        name: "搜索音乐",
        description: "Search local music and NetEase Cloud Music.",
        parameterSchema: MUSIC_SEARCH_PARAMETER_SCHEMA,
    },
    {
        name: "查看音乐状态",
        description: "Show the current track, playback state, play mode and the current queue.",
        parameterSchema: MUSIC_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "查看音乐库概览",
        description: "Show local music, NetEase login state, NetEase playlists and a recent-plays overview.",
        parameterSchema: MUSIC_OVERVIEW_PARAMETER_SCHEMA,
    },
    {
        name: "查看歌单歌曲",
        description: "List the tracks in a NetEase playlist.",
        parameterSchema: MUSIC_PLAYLIST_TRACKS_PARAMETER_SCHEMA,
    },
    {
        name: "加入播放列表",
        description: "Add search results, a specific track, or a whole playlist to the current queue.",
        parameterSchema: MUSIC_QUEUE_PARAMETER_SCHEMA,
    },
    {
        name: "切换音乐",
        description: "Control the current player: next, previous, pause, resume or stop.",
        parameterSchema: MUSIC_SWITCH_PARAMETER_SCHEMA,
    },
];

const CALENDAR_MANAGEMENT_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "查看日程",
        description: "View the current character's schedule for a given week.",
        parameterSchema: CALENDAR_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "添加日程",
        description: "Add one schedule entry.",
        parameterSchema: CALENDAR_ADD_PARAMETER_SCHEMA,
    },
    {
        name: "修改日程",
        description: "Change an existing schedule entry.",
        parameterSchema: CALENDAR_UPDATE_PARAMETER_SCHEMA,
    },
    {
        name: "取消日程",
        description: "Cancel an existing schedule entry.",
        parameterSchema: CALENDAR_DELETE_PARAMETER_SCHEMA,
    },
];

const SEND_FILE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        url: { type: "string", description: "the file's full URL" },
        type: { type: "string", enum: ["audio", "image", "video", "file"], description: "the kind of file" },
        title: { type: "string", description: "a title or description for the file (optional)" },
    },
    required: ["url", "type"],
});

const SEND_FILE_USAGE_GUIDE = [
    "Here is the result of your instruction lookup:",
    "Service: 发送文件 (send a file)",
    "Purpose: send a file at an external URL — audio, image, video or any file — to {{user}}, who can play or download it directly.",
    "",
    "When to use it: once you have a file URL from another tool (a music-generation API, an image-generation API and so on), use this to send the file to {{user}}.",
    "",
    "Action: 发送文件 (send a file)",
    "Parameters:",
    "  - url (string, required): the file's full URL",
    '  - type (string, required): the kind of file — "audio", "image", "video" or "file"',
    "  - title (string, optional): a title or description for the file",
    "Example:",
    '[CallTool:发送文件({"url":"https://example.com/song.mp3","type":"audio","title":"a song I wrote for you"})]',
].join("\n");
const LOCAL_DATA_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "the virtual directory path, default /. For example /characters or /chat/indexeddb/AiPhoneChatDB" },
        limit: { type: "number", description: "maximum number to return, default 30, max 200" },
        offset: { type: "number", description: "paging offset, default 0" },
    },
});

const LOCAL_DATA_READ_FILE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "the path of the virtual file or IndexedDB store to read" },
        limit: { type: "number", description: "maximum number to read from an array or record list, default 30, max 200" },
        offset: { type: "number", description: "paging offset when reading an array or record list, default 0" },
        fields: { type: "array", items: { type: "string" }, description: "optional; return only these fields. Dotted paths work, e.g. mediaData.label" },
        select: { type: "array", items: { type: "string" }, description: "an alias for fields" },
    },
    required: ["path"],
});

const LOCAL_DATA_FIELDS_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "the path of the KV/localStorage JSON file or IndexedDB store whose fields you want to inspect" },
        sample: { type: "number", description: "how many records to sample, default 5, max 50" },
    },
    required: ["path"],
});

const LOCAL_DATA_SEARCH_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "the path to search within, default /. Can be a module, a data source, a KV file or an IndexedDB store" },
        query: { type: "string", description: "search terms; leave empty to return the first few records in that scope" },
        limit: { type: "number", description: "maximum number to return, default 30, max 200" },
        offset: { type: "number", description: "paging offset, default 0" },
        fields: { type: "array", items: { type: "string" }, description: "optional; return only these fields. Dotted paths work, e.g. mediaData.label" },
        select: { type: "array", items: { type: "string" }, description: "an alias for fields" },
    },
    required: ["query"],
});

const LOCAL_DATA_READ_RECORD_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "an IndexedDB store path, e.g. /chat/indexeddb/AiPhoneChatDB/messages" },
        key: { type: "string", description: "the record's primary key; a JSON string works for compound keys" },
        fields: { type: "array", items: { type: "string" }, description: "optional; return only these fields. Dotted paths work, e.g. mediaData.label" },
        select: { type: "array", items: { type: "string" }, description: "an alias for fields" },
    },
    required: ["path", "key"],
});

const LOCAL_DATA_LIBRARY_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "列出资料目录",
        description: "List the local data library's virtual directories, data sources, files, IndexedDB stores or record keys.",
        parameterSchema: LOCAL_DATA_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "读取资料文件",
        description: "Read a KV/localStorage JSON file from the local data library, or read paged records from an IndexedDB store.",
        parameterSchema: LOCAL_DATA_READ_FILE_PARAMETER_SCHEMA,
    },
    {
        name: "查看资料字段",
        description: "Sample the available fields on a data file or IndexedDB store, so a later read can use fields/select to fetch only part of each record.",
        parameterSchema: LOCAL_DATA_FIELDS_PARAMETER_SCHEMA,
    },
    {
        name: "搜索资料记录",
        description: "Search records by keyword within a given path in the local data library. Useful for finding characters, chats, Moments, toolbox entries and so on.",
        parameterSchema: LOCAL_DATA_SEARCH_PARAMETER_SCHEMA,
    },
    {
        name: "读取资料记录",
        description: "Read a single record from an IndexedDB store by primary key.",
        parameterSchema: LOCAL_DATA_READ_RECORD_PARAMETER_SCHEMA,
    },
];

const LOCAL_DATA_LIBRARY_USAGE_GUIDE = [
    "Here is the result of your instruction lookup:",
    "Service: 本地资料库 (local data library)",
    "Purpose: browse, read and search the local data on {{user}}'s phone — character cards, chats, Moments, memories, the toolbox, settings and app data.",
    "",
    "This is a virtual file system, not a real source directory. List a directory first, then read or search what you need, so you never pull back more data than necessary.",
    "",
    "Common paths:",
    "- /characters: character cards and their assets",
    "- /chat: chat contacts, sessions, messages and offline-mode records",
    "- /social: Moments, Xiaohongshu, friend requests and social interaction state",
    "- /memory: long-term memory, core memory and event counts",
    "- /settings: presets, world books, regex, the toolbox and binding settings",
    "",
    "Action: 列出资料目录 (list a directory)",
    "Parameters:",
    "  - path (string): the virtual directory path, default /",
    "  - limit (number): how many to return, default 30, max 200",
    "  - offset (number): paging offset",
    "Example:",
    '[CallTool:列出资料目录({"path":"/"})]',
    "",
    "Action: 读取资料文件 (read a data file)",
    "Parameters:",
    "  - path (string, required): the path of a KV/localStorage JSON file, or of an IndexedDB store",
    "  - limit (number): how many array entries or store records to read, default 30, max 200",
    "  - offset (number): paging offset",
    "  - fields/select (string[]): optional; return only these fields. Dotted paths work, e.g. mediaData.label",
    "Example:",
    '[CallTool:读取资料文件({"path":"/characters/kv/ai_phone_characters_v1.json","limit":20,"fields":["id","name","persona"]})]',
    "",
    "Action: 查看资料字段 (inspect available fields)",
    "Parameters:",
    "  - path (string, required): the path of a KV/localStorage JSON file, or of an IndexedDB store",
    "  - sample (number): how many records to sample, default 5, max 50",
    "Example:",
    '[CallTool:查看资料字段({"path":"/chat/indexeddb/AiPhoneChatDB/messages","sample":5})]',
    "",
    "Action: 搜索资料记录 (search records)",
    "Parameters:",
    "  - path (string): the scope to search, default /",
    "  - query (string, required): search terms; leave empty to return the first few records",
    "  - limit (number): how many to return, default 30, max 200",
    "  - offset (number): paging offset",
    "  - fields/select (string[]): optional; return only these fields. Dotted paths work, e.g. mediaData.label",
    "Example:",
    '[CallTool:搜索资料记录({"path":"/chat","query":"a character name","limit":30,"fields":["id","role","content","createdAt"]})]',
    "",
    "Action: 读取资料记录 (read one record)",
    "Parameters:",
    "  - path (string, required): an IndexedDB store path, e.g. /chat/indexeddb/AiPhoneChatDB/messages",
    "  - key (string, required): the record's primary key",
    "  - fields/select (string[]): optional; return only these fields. Dotted paths work, e.g. mediaData.label",
    "Example:",
    '[CallTool:读取资料记录({"path":"/chat/indexeddb/AiPhoneChatDB/messages","key":"msg_xxx","fields":["id","content"]})]',
].join("\n");
const TOOLBOX_REST_TOOL_PROPERTIES = {
    name: { type: "string", description: "the tool name; must be unique" },
    description: { type: "string", description: "what the tool is for; shown to the AI" },
    endpoint: { type: "string", description: "the HTTP/HTTPS address. {{paramName}} is inserted escaped; {{{paramName}}} is inserted verbatim, for splicing a whole URL or path" },
    method: { type: "string", enum: ["GET", "POST"], description: "the request method" },
    headers: { type: "object", additionalProperties: { type: "string" }, description: "request headers; {{paramName}} placeholders are supported" },
    bodyTemplate: { type: "string", description: "a JSON body template for POST; {{paramName}} placeholders are supported, and a whole value written as {{paramName}} keeps its original type" },
    parameterSchema: { type: "string", description: "a JSON Schema string for the parameters the AI can see" },
    fixedParams: { type: "object", additionalProperties: { type: "string" }, description: "fixed parameters, hidden from the AI — an api_key, for example" },
    directFetch: { type: "boolean", description: "whether to call it directly from the browser; default true" },
};

const TOOLBOX_ADD_REST_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        packageId: { type: "string", description: "the target AI REST package ID; packageId takes precedence" },
        packageName: { type: "string", description: "the target AI REST package name, used when there is no packageId. Leave empty to create a standalone REST tool" },
        ...TOOLBOX_REST_TOOL_PROPERTIES,
        enabled: { type: "boolean", description: "whether to enable it immediately, default true" },
    },
    required: ["name", "description", "endpoint", "method", "parameterSchema"],
});

const TOOLBOX_UPDATE_REST_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI tool ID to update; id takes precedence" },
        name: { type: "string", description: "the AI tool name to update, used when there is no id" },
        updates: {
            type: "object",
            description: "the fields to update. Only REST tools created by the AI can be updated.",
            properties: {
                packageId: { type: "string", description: "the AI REST package ID to move it into" },
                packageName: { type: "string", description: "the AI REST package name to move it into" },
                ...TOOLBOX_REST_TOOL_PROPERTIES,
                enabled: { type: "boolean", description: "whether it is enabled" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_REST_TOOL_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI tool ID to enable or disable; id takes precedence" },
        name: { type: "string", description: "the AI tool name to enable or disable, used when there is no id" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_REST_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI tool ID to delete; id takes precedence" },
        name: { type: "string", description: "the AI tool name to delete, used when there is no id" },
    },
});

const TOOLBOX_ADD_REST_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        name: { type: "string", description: "the package name; must be unique" },
        description: { type: "string", description: "what the package is for; shown to the AI" },
        enabled: { type: "boolean", description: "whether to enable it immediately, default true" },
    },
    required: ["name", "description"],
});

const TOOLBOX_UPDATE_REST_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI REST package ID to update; id takes precedence" },
        name: { type: "string", description: "the AI REST package name to update, used when there is no id" },
        updates: {
            type: "object",
            description: "the fields to update. Only REST packages created by the AI can be updated.",
            properties: {
                name: { type: "string", description: "the new package name; must be unique" },
                description: { type: "string", description: "the new description of what the package is for" },
                enabled: { type: "boolean", description: "whether it is enabled" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_REST_PACKAGE_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI REST package ID to enable or disable; id takes precedence" },
        name: { type: "string", description: "the AI REST package name to enable or disable, used when there is no id" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_REST_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI REST package ID to delete; id takes precedence" },
        name: { type: "string", description: "the AI REST package name to delete, used when there is no id" },
    },
});

const TOOLBOX_COMPOSITE_STEP_SCHEMA = {
    type: "object",
    properties: {
        toolName: { type: "string", description: "the exact action name to call — a REST tool, an internal action such as 读取资料文件, an MCP sub-tool name, or a composite tool name" },
        toolType: { type: "string", enum: ["auto", "rest", "internal", "mcp", "composite", "script"], description: "the tool category; use auto when unsure. script runs a piece of JS as an intermediate step" },
        toolId: { type: "string", description: "optional REST or composite tool ID, to pin down the right one when names collide" },
        serverId: { type: "string", description: "optional MCP server ID, to pin down the right tool when MCP tool names collide" },
        argsTemplate: { type: "object", description: "the argument template passed to this step; supports {{input.xxx}}, {{last.data}} and {{steps.name.data}}" },
        script: { type: "string", description: "the async JS run when toolType is script. It can reach window, localStorage, fetch and document directly, and must return its result" },
        saveAs: { type: "string", description: "the name this step's result is saved under, so later steps can reference it via {{steps.name.data}}" },
    },
};

const TOOLBOX_COMPOSITE_TOOL_PROPERTIES = {
    name: { type: "string", description: "the composite tool's name; must be unique" },
    description: { type: "string", description: "what the composite tool is for; shown to the AI" },
    parameterSchema: { type: "string", description: "a JSON Schema string for the parameters the composite tool exposes to the AI" },
    steps: { type: "array", items: TOOLBOX_COMPOSITE_STEP_SCHEMA, description: "the list of steps, run in order" },
    outputTemplate: { type: "string", description: "the template for the final result; supports {{last.data}} and {{steps.name.data}}. Leave empty to return a summary of the steps" },
};

const TOOLBOX_ADD_COMPOSITE_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        packageId: { type: "string", description: "the target AI composite-tool package ID; packageId takes precedence" },
        packageName: { type: "string", description: "the target AI composite-tool package name, used when there is no packageId. Leave empty to create a standalone composite tool" },
        ...TOOLBOX_COMPOSITE_TOOL_PROPERTIES,
        enabled: { type: "boolean", description: "whether to enable it immediately, default true" },
    },
    required: ["name", "description", "parameterSchema", "steps"],
});

const TOOLBOX_UPDATE_COMPOSITE_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI composite tool ID to update; id takes precedence" },
        name: { type: "string", description: "the AI composite tool name to update, used when there is no id" },
        updates: {
            type: "object",
            description: "the fields to update. Only composite tools created by the AI can be updated.",
            properties: {
                packageId: { type: "string", description: "the AI composite-tool package ID to move it into" },
                packageName: { type: "string", description: "the AI composite-tool package name to move it into" },
                ...TOOLBOX_COMPOSITE_TOOL_PROPERTIES,
                enabled: { type: "boolean", description: "whether it is enabled" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_COMPOSITE_TOOL_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI composite tool ID to enable or disable; id takes precedence" },
        name: { type: "string", description: "the AI composite tool name to enable or disable, used when there is no id" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_COMPOSITE_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI composite tool ID to delete; id takes precedence" },
        name: { type: "string", description: "the AI composite tool name to delete, used when there is no id" },
    },
});

const TOOLBOX_ADD_COMPOSITE_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        name: { type: "string", description: "the composite-tool package name; must be unique" },
        description: { type: "string", description: "what the package is for; shown to the AI" },
        enabled: { type: "boolean", description: "whether to enable it immediately, default true" },
    },
    required: ["name", "description"],
});

const TOOLBOX_UPDATE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI composite-tool package ID to update; id takes precedence" },
        name: { type: "string", description: "the AI composite-tool package name to update, used when there is no id" },
        updates: {
            type: "object",
            description: "the fields to update. Only composite-tool packages created by the AI can be updated.",
            properties: {
                name: { type: "string", description: "the new package name; must be unique" },
                description: { type: "string", description: "the new description of what the package is for" },
                enabled: { type: "boolean", description: "whether it is enabled" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_COMPOSITE_PACKAGE_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI composite-tool package ID to enable or disable; id takes precedence" },
        name: { type: "string", description: "the AI composite-tool package name to enable or disable, used when there is no id" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "the AI composite-tool package ID to delete; id takes precedence" },
        name: { type: "string", description: "the AI composite-tool package name to delete, used when there is no id" },
    },
});

const TOOLBOX_MANAGEMENT_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "添加REST套件",
        description: "Add an AI-created REST tool package, used to group several REST sub-tools together.",
        parameterSchema: TOOLBOX_ADD_REST_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "更新REST套件",
        description: "Update a REST tool package the AI created itself. Packages created by the user, and built-in ones, cannot be updated.",
        parameterSchema: TOOLBOX_UPDATE_REST_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "设置REST套件启用",
        description: "Enable or disable a REST tool package the AI created itself. Packages created by the user, and built-in ones, cannot be touched.",
        parameterSchema: TOOLBOX_SET_REST_PACKAGE_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除REST套件",
        description: "Delete a REST tool package the AI created itself, along with the AI-created REST sub-tools inside it.",
        parameterSchema: TOOLBOX_DELETE_REST_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "添加REST工具",
        description: "Add an AI-created REST tool. It can stand alone or go inside a REST package the AI created.",
        parameterSchema: TOOLBOX_ADD_REST_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "更新REST工具",
        description: "Update a REST tool the AI created itself. Tools created by the user, and built-in ones, cannot be updated.",
        parameterSchema: TOOLBOX_UPDATE_REST_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "设置REST工具启用",
        description: "Enable or disable a REST tool the AI created itself. Tools created by the user, and built-in ones, cannot be touched.",
        parameterSchema: TOOLBOX_SET_REST_TOOL_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除REST工具",
        description: "Delete a REST tool the AI created itself. Tools created by the user, and built-in ones, cannot be deleted.",
        parameterSchema: TOOLBOX_DELETE_REST_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "添加组合工具套件",
        description: "Add an AI-created composite-tool package, used to group several composite tools together.",
        parameterSchema: TOOLBOX_ADD_COMPOSITE_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "更新组合工具套件",
        description: "Update a composite-tool package the AI created itself. Packages created by the user, and built-in ones, cannot be updated.",
        parameterSchema: TOOLBOX_UPDATE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "设置组合工具套件启用",
        description: "Enable or disable a composite-tool package the AI created itself. Packages created by the user, and built-in ones, cannot be touched.",
        parameterSchema: TOOLBOX_SET_COMPOSITE_PACKAGE_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除组合工具套件",
        description: "Delete a composite-tool package the AI created itself, along with the AI-created composite tools inside it.",
        parameterSchema: TOOLBOX_DELETE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "添加组合工具",
        description: "Add an AI-created composite tool. It can stand alone or go inside a composite-tool package the AI created.",
        parameterSchema: TOOLBOX_ADD_COMPOSITE_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "更新组合工具",
        description: "Update a composite tool the AI created itself. Tools created by the user, and built-in ones, cannot be updated.",
        parameterSchema: TOOLBOX_UPDATE_COMPOSITE_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "设置组合工具启用",
        description: "Enable or disable a composite tool the AI created itself. Tools created by the user, and built-in ones, cannot be touched.",
        parameterSchema: TOOLBOX_SET_COMPOSITE_TOOL_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除组合工具",
        description: "Delete a composite tool the AI created itself. Tools created by the user, and built-in ones, cannot be deleted.",
        parameterSchema: TOOLBOX_DELETE_COMPOSITE_TOOL_PARAMETER_SCHEMA,
    },
];

const TOOLBOX_MANAGEMENT_USAGE_GUIDE = [
    "Here is the result of your instruction lookup:",
    "Service: 工具箱管理 (toolbox management)",
    "Purpose: create and maintain the REST tools, REST packages, composite tools and composite-tool packages you wrote yourself. You can only change entries whose createdBy is ai — never anything the user made by hand, and never a built-in.",
    "",
    "Suggestions:",
    "- If you are unsure how the existing tools are structured, read them first with 本地资料库: /settings/kv/ai_phone_rest_tool_packages_v1.json, /settings/kv/ai_phone_rest_tools_v1.json, /settings/kv/ai_phone_composite_tool_packages_v1.json and /settings/kv/ai_phone_composite_tools_v1.json.",
    "- For a single standalone capability, create a lone REST tool. For several tools of the same kind, create a REST package first and add sub-tools to it.",
    "- REST packages are lazily loaded: the first round offers only the package name, its description and how to fetch it. The sub-tool details are fetched only when the package is actually needed, which saves context.",
    "- Composite tools chain several existing actions in order, and may span REST, MCP, built-in capabilities and other composite tools. Build a lone composite tool for a single flow; create a composite-tool package once there are several flows of the same kind.",
    "- A composite step's argsTemplate supports {{input.xxx}}, {{last.data}} and {{steps.name.data}}, which pass the user's arguments and the previous step's result into the next step.",
    "- Every step's result has a data field. When data is valid JSON the system also provides json, so you can use the object directly via {{steps.name.json}} or steps.name.json inside a script.",
    "- Composite tools support script steps: a script can use input, steps, last, args and context, and may reach window, localStorage, fetch and document directly. await works, and the script must return its result.",
    "- Before adding or updating, make sure parameterSchema is a valid JSON Schema string.",
    "- In an endpoint, {{paramName}} is URL-escaped, which suits query parameters, while {{{paramName}}} is inserted verbatim, which suits splicing a whole address into the path — for example Jina Reader's https://r.jina.ai/http://{{{url}}}.",
    "- If bodyTemplate is given it must be a valid JSON string, and may contain {{paramName}} placeholders. Writing a whole value as \"{{paramName}}\" preserves its original type.",
    "",
    "Action: 添加REST套件 (add a REST package)",
    "Parameters:",
    "  - name (string, required): the package name; must be unique",
    "  - description (string, required): what the package is for",
    "  - enabled (boolean): whether it is enabled, default true",
    "Example:",
    '[CallTool:添加REST套件({"name":"Web research tools","description":"search, read and tidy up web content","enabled":true})]',
    "",
    "Action: 更新REST套件 (update a REST package)",
    "Parameters:",
    "  - id/name: the AI-created package to update",
    "  - updates (object, required): the fields to update",
    "Example:",
    '[CallTool:更新REST套件({"name":"Web research tools","updates":{"description":"web search, article extraction and tidying"}})]',
    "",
    "Action: 设置REST套件启用 (enable or disable a REST package)",
    "Parameters:",
    "  - id/name: the AI-created package to enable or disable",
    "  - enabled (boolean, required): true to enable, false to disable",
    "Example:",
    '[CallTool:设置REST套件启用({"name":"Web research tools","enabled":true})]',
    "",
    "Action: 删除REST套件 (delete a REST package)",
    "Parameters:",
    "  - id/name: the AI-created package to delete",
    "Example:",
    '[CallTool:删除REST套件({"name":"Web research tools"})]',
    "",
    "Action: 添加REST工具 (add a REST tool)",
    "Parameters:",
    "  - packageId/packageName: the target AI REST package; leave empty to create a standalone REST tool",
    "  - name (string, required): the tool name; must be unique",
    "  - description (string, required): what the tool is for",
    "  - endpoint (string, required): the HTTP/HTTPS address. {{paramName}} is escaped, {{{paramName}}} is inserted verbatim",
    "  - method (string, required): GET or POST",
    "  - headers (object): request headers",
    "  - bodyTemplate (string): a JSON body template for POST",
    "  - parameterSchema (string, required): a JSON Schema string for the parameters the AI can see",
    "  - fixedParams (object): fixed parameters, such as an api_key",
    "  - directFetch (boolean): whether to call it directly, default true",
    "  - enabled (boolean): whether it is enabled, default true",
    "Example:",
    '[CallTool:添加REST工具({"packageName":"Web research tools","name":"Read article text","description":"read a web page URL and return its article text","endpoint":"https://r.jina.ai/http://{{{url}}}","method":"GET","directFetch":false,"parameterSchema":"{\\"type\\":\\"object\\",\\"properties\\":{\\"url\\":{\\"type\\":\\"string\\",\\"description\\":\\"the page URL, preferably without https:// or http://\\"}},\\"required\\":[\\"url\\"]}"})]',
    "",
    "Action: 更新REST工具 (update a REST tool)",
    "Parameters:",
    "  - id/name: the AI-created tool to update",
    "  - updates (object, required): the fields to update",
    "Example:",
    '[CallTool:更新REST工具({"name":"Read article text","updates":{"endpoint":"https://api.example.com/read","bodyTemplate":"{\\"input\\":\\"{{url}}\\"}"}})]',
    "",
    "Action: 设置REST工具启用 (enable or disable a REST tool)",
    "Parameters:",
    "  - id/name: the AI-created tool to enable or disable",
    "  - enabled (boolean, required): true to enable, false to disable",
    "Example:",
    '[CallTool:设置REST工具启用({"name":"Read article text","enabled":true})]',
    "",
    "Action: 删除REST工具 (delete a REST tool)",
    "Parameters:",
    "  - id/name: the AI-created tool to delete",
    "Example:",
    '[CallTool:删除REST工具({"name":"Read article text"})]',
    "",
    "Action: 添加组合工具套件 (add a composite-tool package)",
    "Parameters:",
    "  - name (string, required): the package name; must be unique",
    "  - description (string, required): what the package is for",
    "  - enabled (boolean): whether it is enabled, default true",
    "Example:",
    '[CallTool:添加组合工具套件({"name":"Web research flows","description":"search, read, tidy and record material from the web","enabled":true})]',
    "",
    "Action: 添加组合工具 (add a composite tool)",
    "Parameters:",
    "  - packageId/packageName: the target AI composite-tool package; leave empty to create a standalone composite tool",
    "  - name (string, required): the composite tool's name; must be unique",
    "  - description (string, required): what it is for",
    "  - parameterSchema (string, required): a JSON Schema string for the parameters the AI sees when calling it",
    "  - steps (array, required): the steps to run in order. An ordinary step has toolName, toolType (auto/rest/internal/mcp/composite), argsTemplate and saveAs; a script step uses toolType=script, script and saveAs",
    "  - outputTemplate (string): the template for the final result; supports {{last.data}} and {{steps.name.data}}",
    "  - enabled (boolean): whether it is enabled, default true",
    "Example:",
    '[CallTool:添加组合工具({"packageName":"Web research flows","name":"Search and summarise","description":"search for a term and tidy the results into a summary that can be used further","parameterSchema":"{\\"type\\":\\"object\\",\\"properties\\":{\\"query\\":{\\"type\\":\\"string\\",\\"description\\":\\"the search terms\\"}},\\"required\\":[\\"query\\"]}","steps":[{"toolName":"Search","toolType":"rest","argsTemplate":{"query":"{{input.query}}"},"saveAs":"search"}],"outputTemplate":"{{steps.search.data}}","enabled":true})]',
    "Script step example:",
    '{"toolType":"script","saveAs":"matched","script":"const contacts = JSON.parse(steps.contacts.data); const characters = JSON.parse(steps.characters.data); return contacts.map(c => ({ contactName: c.value?.name, characterName: characters.find(x => x.id === c.value?.characterId)?.name || \\"\\" }));"}',
    "",
    "Actions: 更新组合工具 / 更新组合工具套件 / 设置组合工具启用 / 设置组合工具套件启用 / 删除组合工具 / 删除组合工具套件",
    "These work like their REST counterparts above, and likewise only on composite tools and packages the AI created itself.",
].join("\n");
const BUILTIN_INTERNAL_CAPABILITIES: InternalCapabilityConfig[] = [
    {
        id: MEMORY_WRITE_CAPABILITY_ID,
        name: "写入记忆",
        description: "Write clear, stable, lasting information into long-term memory. Limited to relationship milestones, long-term preferences, identity details and significant agreements. Never short-lived moods, small talk, guesses or anything unconfirmed.",
        enabled: false,
        mode: "confirm",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: NOTE_WALL_CAPABILITY_ID,
        name: "便签墙",
        description: "Services for the public community note wall.",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: MUSIC_CONTROL_CAPABILITY_ID,
        name: "网易云音乐",
        description: "Control music playback on {{user}}'s phone, and browse the music library, NetEase playlists and play queue on it.",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: CALENDAR_MANAGEMENT_CAPABILITY_ID,
        name: "日历管理",
        description: "View, add, change and cancel the current character's schedule.",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: SEND_FILE_CAPABILITY_ID,
        name: "发送文件",
        description: "Send a file at an external URL — audio, image or video — to {{user}}, who can play or download it directly. Use it to deliver something produced by another tool.",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: LOCAL_DATA_LIBRARY_CAPABILITY_ID,
        name: "本地资料库",
        description: "Browse, read and search the local data on {{user}}'s phone: character cards, chats, Moments, memories, the toolbox, settings and app data.",
        enabled: true,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: TOOLBOX_MANAGEMENT_CAPABILITY_ID,
        name: "工具箱管理",
        description: "Create, update, enable, disable and delete the REST tools, REST packages, composite tools and composite-tool packages the AI created itself. Never touches anything the user made by hand, or any built-in.",
        enabled: true,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: TIMED_WAKE_CAPABILITY_ID,
        name: "稍后主动联系",
        description: "Let the character arrange to get in touch again later: set a delay and an intention now, and when it comes due the character decides whether to send a message or stay quiet. This is not waking from sleep.",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
];

export function loadInternalCapabilities(): InternalCapabilityConfig[] {
    if (typeof window === "undefined") return BUILTIN_INTERNAL_CAPABILITIES.map(item => ({ ...item }));
    try {
        const raw = kvGet(INTERNAL_CAPABILITIES_KEY);
        const items: InternalCapabilityConfig[] = raw ? JSON.parse(raw) : [];
        return ensureBuiltinInternalCapabilities(items);
    } catch {
        return ensureBuiltinInternalCapabilities([]);
    }
}

export function saveInternalCapabilities(items: InternalCapabilityConfig[]): void {
    if (typeof window === "undefined") return;
    kvSet(INTERNAL_CAPABILITIES_KEY, JSON.stringify(items));
}

export function getInternalCapability(id: string): InternalCapabilityConfig | null {
    return loadInternalCapabilities().find(item => item.id === id) || null;
}

export function getEnabledInternalCapabilities(appId?: string): InternalCapabilityConfig[] {
    if (appId !== "chat" && appId !== "group_chat") return [];
    return loadInternalCapabilities().filter(item => {
        if (!item.enabled || item.mode === "off") return false;
        return true;
    });
}

export function getInternalCapabilityToolDefinition(capability: InternalCapabilityConfig): InternalToolDefinition | null {
    if (capability.id === MEMORY_WRITE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: MEMORY_WRITE_PARAMETER_SCHEMA,
            usageGuide: MEMORY_WRITE_USAGE_GUIDE,
        };
    }
    if (capability.id === NOTE_WALL_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: NOTE_WALL_USAGE_GUIDE,
        };
    }
    if (capability.id === MUSIC_CONTROL_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: MUSIC_CONTROL_USAGE_GUIDE,
        };
    }
    if (capability.id === CALENDAR_MANAGEMENT_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: CALENDAR_MANAGEMENT_USAGE_GUIDE,
        };
    }
    if (capability.id === SEND_FILE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: SEND_FILE_PARAMETER_SCHEMA,
            usageGuide: SEND_FILE_USAGE_GUIDE,
        };
    }
    if (capability.id === LOCAL_DATA_LIBRARY_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: LOCAL_DATA_LIBRARY_USAGE_GUIDE,
        };
    }
    if (capability.id === TOOLBOX_MANAGEMENT_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: TOOLBOX_MANAGEMENT_USAGE_GUIDE,
        };
    }
    if (capability.id === TIMED_WAKE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: TIMED_WAKE_PARAMETER_SCHEMA,
            usageGuide: TIMED_WAKE_USAGE_GUIDE,
        };
    }
    return null;
}

export function getInternalCapabilitySubToolDefinition(
    capability: InternalCapabilityConfig,
    name: string,
): InternalToolDefinition | null {
    if (capability.id === NOTE_WALL_CAPABILITY_ID) {
        return NOTE_WALL_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === MUSIC_CONTROL_CAPABILITY_ID) {
        return MUSIC_CONTROL_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === CALENDAR_MANAGEMENT_CAPABILITY_ID) {
        return CALENDAR_MANAGEMENT_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === LOCAL_DATA_LIBRARY_CAPABILITY_ID) {
        return LOCAL_DATA_LIBRARY_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === TOOLBOX_MANAGEMENT_CAPABILITY_ID) {
        return TOOLBOX_MANAGEMENT_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    return null;
}

export function getInternalCapabilitySubToolDefinitions(
    capability: InternalCapabilityConfig,
): InternalToolDefinition[] {
    if (capability.id === NOTE_WALL_CAPABILITY_ID) {
        return NOTE_WALL_SUBTOOLS;
    }
    if (capability.id === MUSIC_CONTROL_CAPABILITY_ID) {
        return MUSIC_CONTROL_SUBTOOLS;
    }
    if (capability.id === CALENDAR_MANAGEMENT_CAPABILITY_ID) {
        return CALENDAR_MANAGEMENT_SUBTOOLS;
    }
    if (capability.id === LOCAL_DATA_LIBRARY_CAPABILITY_ID) {
        return LOCAL_DATA_LIBRARY_SUBTOOLS;
    }
    if (capability.id === TOOLBOX_MANAGEMENT_CAPABILITY_ID) {
        return TOOLBOX_MANAGEMENT_SUBTOOLS;
    }
    return [];
}

export function findEnabledInternalSubToolDefinition(
    name: string,
    appId?: string,
): { capability: InternalCapabilityConfig; tool: InternalToolDefinition } | null {
    for (const capability of getEnabledInternalCapabilities(appId)) {
        const tool = getInternalCapabilitySubToolDefinition(capability, name);
        if (tool) return { capability, tool };
    }
    return null;
}

function ensureBuiltinInternalCapabilities(items: InternalCapabilityConfig[]): InternalCapabilityConfig[] {
    let changed = false;
    for (const builtin of BUILTIN_INTERNAL_CAPABILITIES) {
        const existing = items.find(item => item.id === builtin.id);
        if (!existing) {
            items.push({ ...builtin });
            changed = true;
        } else if (existing.name !== builtin.name || existing.description !== builtin.description) {
            existing.name = builtin.name;
            existing.description = builtin.description;
            changed = true;
        }
    }
    if (changed) saveInternalCapabilities(items);
    return items;
}
