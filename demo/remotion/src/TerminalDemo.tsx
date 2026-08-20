import React from "react";
import { cubicBezier, spring as motionSpring, transform } from "motion";
import {
  AbsoluteFill,
  Audio,
  Composition,
  staticFile,
  useCurrentFrame,
} from "remotion";

const FPS = 30;
export const DURATION = 360;
const theme = {
  text: "#171717",
  muted: "#777777",
  prompt: "#9a9a9a",
  hairline: "#e9e9e9",
  panel: "#f6f6f6",
  work: "#222222",
  side: "#777777",
  personal: "#bcbcbc",
  fallback: "#d1d1d1",
};
const fontFamily =
  '"SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", "Courier New", monospace';
const clamp = (n: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, n));
const easeOut = cubicBezier(0.22, 1, 0.36, 1);

function springProgress(
  frame: number,
  start: number,
  options: { stiffness?: number; damping?: number; mass?: number } = {},
) {
  const elapsed = Math.max(0, frame - start) * (1000 / FPS);
  const generator = motionSpring({
    keyframes: [0, 1],
    stiffness: options.stiffness ?? 180,
    damping: options.damping ?? 24,
    mass: options.mass ?? 1,
  });
  return clamp(Number(generator.next(elapsed).value ?? 0), -0.04, 1.04);
}

function colorizeCommand(command: string) {
  const chars: string[] = [];
  const colors: string[] = [];
  const regex = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(command)) !== null) {
    for (let i = lastIndex; i < match.index; i++) {
      chars.push(command[i]);
      colors.push(theme.text);
    }
    const token = match[0];
    let color = theme.text;
    if (/^--?/.test(token)) color = theme.muted;
    else if (
      token.startsWith('"') ||
      token.startsWith("'") ||
      /^https?:/.test(token)
    )
      color = "#5f5f5f";
    else if (token.includes("/")) color = "#353535";
    else if (/^-?\d/.test(token)) color = "#929292";
    for (const ch of token) {
      chars.push(ch);
      colors.push(color);
    }
    lastIndex = regex.lastIndex;
  }
  for (let i = lastIndex; i < command.length; i++) {
    chars.push(command[i]);
    colors.push(theme.text);
  }
  return { text: chars.join(""), colors };
}

function colorJSON(json: string) {
  const parts = json
    .split(/("(?:[^"\\]|\\.)*")|(\{|\}|\[|\]|,|:)|(\s+)/)
    .filter(Boolean);
  return parts.map((part, i) => {
    if (/^"/.test(part))
      return (
        <span key={i} style={{ color: "#595959" }}>
          {part}
        </span>
      );
    if (/^-?\d/.test(part))
      return (
        <span key={i} style={{ color: "#8c8c8c" }}>
          {part}
        </span>
      );
    if (/[{}[\],:]/.test(part))
      return (
        <span key={i} style={{ color: "#a0a0a0" }}>
          {part}
        </span>
      );
    if (/true|false|null/.test(part))
      return (
        <span key={i} style={{ color: "#222222" }}>
          {part}
        </span>
      );
    return <span key={i}>{part}</span>;
  });
}

function colorHeader(line: string) {
  const idx = line.indexOf(":");
  if (idx < 0) return <span style={{ fontWeight: 700 }}>{line}</span>;
  return (
    <>
      <span style={{ fontWeight: 700 }}>{line.slice(0, idx)}</span>
      <span>{line.slice(idx)}</span>
    </>
  );
}

const Typewriter: React.FC<{
  text: string;
  colors: string[];
  start: number;
  duration: number;
}> = ({ text, colors, start, duration }) => {
  const frame = useCurrentFrame();
  const visible = clamp(
    Math.floor(((frame - start) / duration) * text.length),
    0,
    text.length,
  );
  const active = frame >= start && frame <= start + duration;
  const blink = Math.floor(frame / 6) % 2 === 0;
  return (
    <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {Array.from({ length: visible }, (_, i) => (
        <span key={i} style={{ color: colors[i] }}>
          {text[i]}
        </span>
      ))}
      {active && blink && (
        <span style={{ color: theme.text, marginLeft: 2, opacity: 0.72 }}>
          |
        </span>
      )}
    </span>
  );
};

const Prompt: React.FC<{
  children: React.ReactNode;
  start: number;
}> = ({ children, start }) => {
  const frame = useCurrentFrame();
  if (frame < start) return null;
  return (
    <div
      style={{
        marginBottom: 4,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      <span style={{ color: theme.prompt }}>$ </span>
      {children}
    </div>
  );
};

function appearStyle(frame: number, start: number, distance = 8) {
  const progress = springProgress(frame, start, {
    stiffness: 210,
    damping: 25,
  });
  const eased = easeOut(clamp(progress));
  return {
    opacity: eased,
    transform: `translateY(${transform(progress, [0, 1], [distance, 0])}px)`,
  };
}

const StatusPanel: React.FC<{ start: number }> = ({ start }) => {
  const frame = useCurrentFrame();
  if (frame < start) return null;
  const data = [
    { alias: "work", quota: 0.71, color: theme.work },
    { alias: "side", quota: 0.34, color: theme.side },
    { alias: "personal", quota: 0.08, color: theme.personal },
  ];
  const barMax = 310;
  return (
    <div style={{ ...appearStyle(frame, start), margin: "5px 0 10px" }}>
      {data.map((item, i) => {
        const progress = springProgress(frame, start + 5 + i * 5, {
          stiffness: 155,
          damping: 20,
        });
        const width = transform(progress, [0, 1], [0, item.quota * barMax]);
        return (
          <div
            key={item.alias}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              height: 22,
            }}
          >
            <span style={{ width: 68, color: theme.text }}>{item.alias}</span>
            <div
              style={{
                width: barMax,
                height: 9,
                background: theme.panel,
                borderRadius: 99,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width,
                  height: "100%",
                  background: item.color,
                  borderRadius: 99,
                }}
              />
            </div>
            <span style={{ width: 38, color: theme.muted, textAlign: "right" }}>
              {Math.round(item.quota * 100)}%
            </span>
          </div>
        );
      })}
      <div
        style={{
          marginLeft: 78,
          color: theme.text,
          marginTop: 4,
          fontWeight: 600,
        }}
      >
        → next request: work
      </div>
    </div>
  );
};

const UsagePanel: React.FC<{ start: number }> = ({ start }) => {
  const frame = useCurrentFrame();
  if (frame < start) return null;
  const barMax = 210;
  const progress = springProgress(frame, start + 5, {
    stiffness: 155,
    damping: 20,
  });
  const subWidth = transform(progress, [0, 1], [0, barMax]);
  const rows = [
    {
      label: "subs",
      width: subWidth,
      color: theme.work,
      detail: "5 tokens · $0.000032",
    },
    {
      label: "API fallback",
      width: 0,
      color: theme.fallback,
      detail: "0 tokens · $0.000000",
    },
  ];
  return (
    <div style={{ ...appearStyle(frame, start), marginTop: 5 }}>
      {rows.map((row) => (
        <div
          key={row.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            height: 24,
          }}
        >
          <span style={{ width: 94, color: theme.text }}>{row.label}</span>
          <div
            style={{
              width: barMax,
              height: 9,
              background: theme.panel,
              borderRadius: 99,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: row.width,
                height: "100%",
                background: row.color,
                borderRadius: 99,
              }}
            />
          </div>
          <span style={{ width: 160, color: theme.muted }}>{row.detail}</span>
        </div>
      ))}
    </div>
  );
};

export const TerminalDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const c1 =
    "npx @puffle/pattystack --fake=work:0.71 --fake=side:0.34 --fake=personal:0.08";
  const c2 = "patty status";
  const c3 =
    'curl -s -i http://127.0.0.1:3210/v1/chat/completions -H "authorization: Bearer $KEY" -H "content-type: application/json" -d \'{"model":"gpt-5-codex","messages":[{"role":"user","content":"hello"}]}\'';
  const c4 = "patty usage";
  const c1col = colorizeCommand(c1);
  const c2col = colorizeCommand(c2);
  const c3col = colorizeCommand(c3);
  const c4col = colorizeCommand(c4);

  const C1_START = 0;
  const C1_DUR = 54;
  const O1_START = 66;
  const C2_START = 100;
  const C2_DUR = 14;
  const O2_START = 124;
  const C3_START = 195;
  const C3_DUR = 66;
  const O3_START = 265;
  const C4_START = 286;
  const C4_DUR = 12;
  const O4_START = 314;

  const daemonJson =
    '{"listening":{"address":"127.0.0.1","port":3210},"apiKey":"cp_live_...","warning":"API key shown once; store it securely"}';
  const bodyJson =
    '{"id":"run_c9bd530cf7a55647f964","object":"chat.completion","model":"gpt-5-codex","choices":[{"index":0,"message":{"role":"assistant","content":"fake: hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}';
  const cardProgress = springProgress(frame, 0, {
    stiffness: 170,
    damping: 23,
  });
  const bgShift = 50 + 8 * Math.sin(frame / 90);

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at ${bgShift}% 20%, #ffffff 0%, #f4f4f4 38%, #e7e7e7 100%)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily,
        fontSize: 13,
        color: theme.text,
        lineHeight: "19px",
      }}
    >
      <Audio src={staticFile("piano.mp3")} volume={0.55} />
      <div
        style={{
          width: 1160,
          height: 650,
          background: "#fff",
          border: `1px solid ${theme.hairline}`,
          borderRadius: 18,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow:
            "0 30px 90px rgba(0,0,0,0.13), 0 3px 12px rgba(0,0,0,0.05)",
          opacity: clamp(cardProgress),
          transform: `scale(${transform(cardProgress, [0, 1], [0.965, 1])})`,
        }}
      >
        <div
          style={{
            height: 36,
            background: "linear-gradient(#fafafa, #f4f4f4)",
            borderBottom: `1px solid ${theme.hairline}`,
            display: "flex",
            alignItems: "center",
            padding: "0 15px",
            gap: 7,
            flexShrink: 0,
          }}
        >
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                background: i === 0 ? "#cfcfcf" : "#dfdfdf",
              }}
            />
          ))}
          <span
            style={{
              marginLeft: 10,
              fontSize: 11,
              color: theme.muted,
              fontFamily: "sans-serif",
              letterSpacing: 0.2,
            }}
          >
            ~ pattystack
          </span>
          <span
            style={{
              marginLeft: "auto",
              color: "#b0b0b0",
              fontSize: 11,
            }}
          >
            local operator console
          </span>
        </div>

        <div style={{ padding: "20px 28px", flex: 1, overflow: "hidden" }}>
          <Prompt start={C1_START}>
            <Typewriter
              text={c1col.text}
              colors={c1col.colors}
              start={C1_START}
              duration={C1_DUR}
            />
          </Prompt>

          {frame >= O1_START && (
            <pre
              style={{
                ...appearStyle(frame, O1_START),
                margin: "3px 0 10px",
                fontFamily,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {colorJSON(daemonJson)}
            </pre>
          )}

          <Prompt start={C2_START}>
            <Typewriter
              text={c2col.text}
              colors={c2col.colors}
              start={C2_START}
              duration={C2_DUR}
            />
          </Prompt>
          <StatusPanel start={O2_START} />

          <Prompt start={C3_START}>
            <Typewriter
              text={c3col.text}
              colors={c3col.colors}
              start={C3_START}
              duration={C3_DUR}
            />
          </Prompt>
          {frame >= O3_START && (
            <div
              style={{ ...appearStyle(frame, O3_START), margin: "3px 0 10px" }}
            >
              <div style={{ color: theme.text, marginBottom: 2 }}>
                {colorHeader("HTTP/1.1 200 OK")}
              </div>
              <div style={{ color: theme.text, marginBottom: 4 }}>
                {colorHeader("x-patty-sub: work")}
              </div>
              <pre
                style={{
                  margin: 0,
                  fontFamily,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {colorJSON(bodyJson)}
              </pre>
            </div>
          )}

          <Prompt start={C4_START}>
            <Typewriter
              text={c4col.text}
              colors={c4col.colors}
              start={C4_START}
              duration={C4_DUR}
            />
          </Prompt>
          <UsagePanel start={O4_START} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const TerminalDemoComposition: React.FC = () => (
  <Composition
    id="TerminalDemo"
    component={TerminalDemo}
    durationInFrames={DURATION}
    fps={FPS}
    width={1280}
    height={720}
    defaultProps={{}}
  />
);
