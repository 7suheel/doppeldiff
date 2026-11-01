/**
 * Renders the README assets from REAL doppeldiff output on the demo scenarios:
 *   docs/assets/pr-comment.png: the Markdown report for the "AI refactor" PR, rendered with GitHub's stylesheet
 *   docs/assets/demo.gif: the CLI run on the same PR, replayed frame by frame
 * Requires: npm run build, Playwright (Chromium), ffmpeg.
 * Usage: node --import tsx scripts/render-assets.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { marked } from 'marked';
import { gitScenario, REPO_ROOT } from '../test/helpers/scenarios.js';

// Playwright is resolved with require() so a globally installed copy (NODE_PATH) works too.
interface Page {
  setContent(html: string): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  $(selector: string): Promise<{ screenshot(options: { path: string }): Promise<unknown> } | null>;
  close(): Promise<void>;
}
interface Browser {
  newPage(options: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<Page>;
  close(): Promise<void>;
}
const { chromium } = createRequire(import.meta.url)('playwright') as {
  chromium: { launch(): Promise<Browser> };
};

const OUT = join(REPO_ROOT, 'docs', 'assets');
mkdirSync(OUT, { recursive: true });
const CLI = join(REPO_ROOT, 'dist', 'cli.js');

const s = gitScenario('ai-refactor', 'branch');
const claim = join(s.repo, '.claim.md');
writeFileSync(claim, s.claim);
const mdPath = join(s.repo, '.report.md');

// 1. One real run, with colors: progress (stderr) and the final report (stdout), captured as ANSI text.
const runResult = spawnSync(
  process.execPath,
  [CLI, '--base', 'main', '--head', 'pr', '--claim-file', claim, '--markdown', mdPath, '--fail-on', 'never'],
  { cwd: s.repo, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', COLUMNS: '96' } },
);
const terminal = runResult.stdout;
const stderrRun = runResult.stderr;
const markdown = readFileSync(mdPath, 'utf8');
s.cleanup();

// ANSI SGR → HTML (only what picocolors emits).
/* eslint-disable no-control-regex */
const COLORS: Record<number, string> = {
  31: '#ff6b6b',
  32: '#5af78e',
  33: '#f3f99d',
  35: '#ff6ac1',
  36: '#9aedfe',
  90: '#808080',
};
function ansiToHtml(text: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  let open = 0;
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!m) {
      out += esc(part);
      continue;
    }
    for (const code of m[1]!.split(';').map(Number)) {
      if (code === 0 || code === 22 || code === 39) {
        if (open > 0) {
          out += '</span>';
          open--;
        }
      } else if (code === 1) {
        out += '<span style="font-weight:700">';
        open++;
      } else if (code === 2) {
        out += '<span style="opacity:.6">';
        open++;
      } else if (COLORS[code]) {
        out += `<span style="color:${COLORS[code]}">`;
        open++;
      }
    }
  }
  return out + '</span>'.repeat(open);
}

const browser = await chromium.launch();

// 2. PR comment screenshot.
{
  const css = readFileSync(
    join(REPO_ROOT, 'node_modules', 'github-markdown-css', 'github-markdown-light.css'),
    'utf8',
  );
  const body = await marked.parse(markdown.replace(/<!--.*?-->/g, ''));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
    body { margin: 0; background: #f6f8fa; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .comment { margin: 24px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; width: 920px; }
    .header { padding: 8px 16px; background: #f6f8fa; border-bottom: 1px solid #d0d7de; font-size: 14px; color: #57606a; border-radius: 6px 6px 0 0; }
    .header b { color: #24292f; }
    .markdown-body { padding: 16px; font-size: 14px; }
    .markdown-body table { font-size: 12.5px; }
  </style></head><body><div class="comment"><div class="header"><b>github-actions</b> <span>bot</span> commented</div>
  <article class="markdown-body">${body}</article></div></body></html>`;
  const page = await browser.newPage({ viewport: { width: 980, height: 800 }, deviceScaleFactor: 2 });
  await page.setContent(html);
  const el = await page.$('.comment');
  await el!.screenshot({ path: join(OUT, 'pr-comment.png') });
  await page.close();
}

// 3. Terminal GIF: type the command, then reveal the real output line by line.
{
  const frames = mkdtempSync(join(tmpdir(), 'doppeldiff-frames-'));
  const command = 'npx doppeldiff --base main --claim-file pr.md';
  const lines = [...stderrRun.trimEnd().split('\n'), ...terminal.split('\n')];
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 1 });
  const render = async (typed: string, shown: number, cursor: boolean) => {
    const out = lines.slice(0, shown).map(ansiToHtml).join('\n');
    const visible = out.split('\n').slice(-30).join('\n');
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; background: #1e1f29; }
      .win { margin: 0; height: 640px; box-sizing: border-box; padding: 40px 22px 18px; background: #282a36; color: #f8f8f2;
             font: 14px/1.42 "DejaVu Sans Mono", Menlo, monospace; white-space: pre; overflow: hidden; position: relative; }
      .bar { position: absolute; top: 12px; left: 16px; }
      .bar i { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 6px; }
      .p { color: #5af78e; } .c { background: #f8f8f2; }
    </style></head><body><div class="win"><div class="bar"><i style="background:#ff5c57"></i><i style="background:#f3f99d"></i><i style="background:#5af78e"></i></div><span class="p">~/shop (ai-refactor) $ </span>${typed}${cursor ? '<span class="c"> </span>' : ''}${shown > 0 ? '\n' + visible : ''}</div></body></html>`);
  };
  let n = 0;
  const shot = async () => page.screenshot({ path: join(frames, `f${String(n++).padStart(4, '0')}.png`) });
  for (let i = 0; i <= command.length; i += 2) {
    await render(command.slice(0, i), 0, true);
    await shot();
  }
  for (let k = 0; k < 4; k++) await shot();
  for (let shown = 1; shown <= lines.length; shown++) {
    await render(command, shown, false);
    await shot();
    if (shown <= 5) for (let k = 0; k < 3; k++) await shot();
  }
  for (let k = 0; k < 40; k++) await shot();
  await page.close();
  const palette = join(frames, 'palette.png');
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    '12',
    '-i',
    join(frames, 'f%04d.png'),
    '-vf',
    'palettegen=max_colors=64',
    palette,
  ]);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    '12',
    '-i',
    join(frames, 'f%04d.png'),
    '-i',
    palette,
    '-lavfi',
    'paletteuse=dither=none',
    '-loop',
    '0',
    join(OUT, 'demo.gif'),
  ]);
  rmSync(frames, { recursive: true, force: true });
}

await browser.close();
console.log('wrote docs/assets/pr-comment.png and docs/assets/demo.gif');
