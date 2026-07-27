/**
 * 检测图片亮度，返回 "light" 或 "dark"。
 * 采样图片上部 40% 区域（状态栏所在位置）的平均亮度。
 */
export function detectImageBrightness(url: string): Promise<"light" | "dark"> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 50;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve("light"); return; }
      ctx.drawImage(img, 0, 0, size, size);
      const sampleH = Math.round(size * 0.4);
      const data = ctx.getImageData(0, 0, size, sampleH).data;
      let total = 0;
      const count = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      resolve(total / count < 128 ? "dark" : "light");
    };
    img.onerror = () => resolve("light");
    img.src = url;
  });
}

/** 解析 rgb()/rgba() 字符串的亮度 */
function colorBrightness(color: string): number | null {
  const m = color.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
}

/**
 * 检测任意 DOM 元素的视觉背景亮度。
 * 依次检查 background-image（URL）和 background-color。
 */
export async function detectElementTone(el: HTMLElement): Promise<"light" | "dark"> {
  const style = getComputedStyle(el);

  // 1. 优先检测背景图片
  const bgImage = style.backgroundImage;
  const urlMatch = bgImage.match(/url\(["']?(.+?)["']?\)/);
  if (urlMatch) {
    return detectImageBrightness(urlMatch[1]);
  }

  // 2. 检测背景色
  const bgColor = style.backgroundColor;
  if (bgColor && bgColor !== "transparent" && bgColor !== "rgba(0, 0, 0, 0)") {
    const b = colorBrightness(bgColor);
    if (b !== null) return b < 128 ? "dark" : "light";
  }

  return "light";
}

/**
 * 按优先级查找当前可见的背景元素。
 * 更具体的（如聊天室）优先于更通用的（如 app 外壳）。
 */
function findBgElement(shell: HTMLElement, activeApp: string | null): HTMLElement | null {
  if (!activeApp) {
    // 主页 → 壁纸
    return shell.querySelector(".phone-wallpaper");
  }

  // 按优先级：具体子页面 > app 容器 > workspace 兜底
  const selectors = [
    '[class*="session-"]',        // 聊天室（z-20，最上层）
    '.page-shell',                // 设置/外观/资源库
    '[class*="char-page"]',       // 角色管理
    '.chat-app',                  // 聊天 app 容器（联系人/会话列表）
    '.phone-app-pane > *',        // 任何 app 最外层容器（改进 fallback）
  ];

  for (const sel of selectors) {
    const el = shell.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

/**
 * 检测当前可见背景的亮度并设置 --status-bar-color。
 * 由 desktop-shell 在 app 切换和 DOM 变化时调用。
 */
export async function updateStatusBarTone(shell: HTMLElement, activeApp: string | null) {
  const el = findBgElement(shell, activeApp);
  const tone = el ? await detectElementTone(el) : "light";

  shell.style.setProperty(
    "--status-bar-color",
    tone === "dark" ? "rgba(255,255,255,0.9)" : "#1a1a1a"
  );

  // Drive the browser/PWA status-bar background to follow the page (light/dark).
  // This is what colors Edge's minimal-ui status bar; harmless on other browsers.
  if (typeof document !== "undefined") {
    let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = tone === "dark" ? "#121110" : "#f8f7f2";
  }
}
