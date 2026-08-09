import fs from "node:fs";
import { createJiti } from "jiti";
const root = process.cwd();
const jiti = createJiti(root, { interopDefault: true, alias: { "@": root } });
const E = await jiti.import("./lib/checkphone-engine.ts");
const SRC = fs.readFileSync("lib/checkphone-engine.ts", "utf8");

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond && extra !== undefined) console.log("      got:", JSON.stringify(extra).slice(0, 400));
};

// ── Photos (exported): album metadata must be split off at the first photo block ──
const photosEn = `#Albums1
[AlbumName]Summer
[Count]2
##Photo1
[Description]a beach at dusk
##Photo2
[Description]a paper cup on sand`;
const photos = E.parsePhotosBlockPayload(photosEn);
const albums = photos?.parsed?.albums ?? [];
check("photos EN: album parsed", albums.length === 1, { mode: photos?.parseMode, err: photos?.parseError });
check("photos EN: 2 photos split out of the album", (albums[0]?.photos?.length ?? 0) === 2, albums[0]);

// NOTE: the photos fix (##Photo / ###Photo split points) is asserted structurally
// below rather than behaviourally. Its effect is that photo blocks stop being
// folded into albumMetaBlock; constructing a payload that demonstrates that
// pollution proved fiddly, and the substituted helper (photoHeadingPattern) is
// already proven bilingual by _fx-checkphone-blocks.mjs.

const photosZh = `#相簿1
[相册名]夏天
[数量]2
##照片1
[描述]黄昏的海滩`;
const photosL = E.parsePhotosBlockPayload(photosZh);
check("photos legacy ZH still parses", (photosL?.parsed?.albums?.length ?? 0) === 1, { mode: photosL?.parseMode });

// ── Douban (exported): profile must be read from ABOVE the first activity block ──
const doubanEn = `[Nickname]Wen
[Signature]reading slowly
#Feed1
[Type]book
[Title]Some Novel`;
const douban = E.parseDoubanBlockPayload(doubanEn);
check("douban EN: profile name from header only",
    douban?.parsed?.profile?.name === "Wen", { name: douban?.parsed?.profile?.name, mode: douban?.parseMode });

// Discriminating case: a nickname inside an activity block. If the first-activity
// index is not found, the profile is parsed from the whole document and the later
// value wins, so the profile silently takes its name from a feed entry.
const doubanCollide = `[Nickname]Wen
#Feed1
[Nickname]LEAKED_FROM_FEED
[Type]book`;
check("douban EN: activity fields do NOT leak into the profile",
    E.parseDoubanBlockPayload(doubanCollide)?.parsed?.profile?.name === "Wen",
    { name: E.parseDoubanBlockPayload(doubanCollide)?.parsed?.profile?.name });

const doubanZh = `[昵称]文
[签名]慢慢读
#动态1
[类型]书
[标题]某本小说`;
check("douban legacy ZH still parses",
    E.parseDoubanBlockPayload(doubanZh)?.parsed?.profile?.name === "文");

// ── Messages: the optional top heading is now stripped in BOTH languages.
// Tested as an equivalence (with vs without the header) rather than a full parse,
// since that is precisely what the change affects.
const msgsBody = `##Threads1
[ThreadId]t1
[Sender]Sam
[Message1Body]hello`;
const bare = JSON.stringify(E.parseMessagesBlockPayload(msgsBody)?.parsed);
const withEn = JSON.stringify(E.parseMessagesBlockPayload(`#Threads\n${msgsBody}`)?.parsed);
const withZh = JSON.stringify(E.parseMessagesBlockPayload(`#线程\n${msgsBody}`)?.parsed);
check("messages: English #Threads header stripped (same as no header)", withEn === bare, { bare, withEn });
check("messages: legacy #线程 header still stripped", withZh === bare, { bare, withZh });

// ── Source-level: no heading regex bakes a label anymore ──
// (parseRedditBlockPayload is module-private, so it is asserted structurally;
//  blockLabelPattern's bilingual behaviour is already proven by _fx-checkphone-blocks.)
const bakedHeadingRe = /\^#{1,3}\\{0,2}s\*(?!\(\?:\$\{)[^`'"/]*[一-鿿]/g;
const bakedLines = SRC.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => !l.trim().startsWith("//"))
    .filter(([, l]) => /\^#{1,3}/.test(l) && /[一-鿿]/.test(l) && !/blockLabelPattern|photoHeadingPattern/.test(l));
check("no heading regex bakes a CJK label", bakedLines.length === 0, bakedLines.map(([n, l]) => `${n}: ${l.trim()}`));

check("reddit sub-block goes through blockLabelPattern",
    /\^##\\\\s\*\(\?:\$\{blockLabelPattern\(blockLabel\)\}\)/.test(SRC),
    (SRC.match(/.*blockLabel\}.*/) || SRC.match(/.*blockLabelPattern\(blockLabel\).*/) || [""])[0].trim());

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
