import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { connectPty } from "../api";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  ptyPid: number;
  onReady?: (cols: number, rows: number) => void;
}

export default function SandboxTerminal({ ptyPid, onReady }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const connRef = useRef<ReturnType<typeof connectPty> | null>(null);

  // Initialize xterm.js
  useEffect(() => {
    if (!terminalRef.current) return;
    if (xtermRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 14,
      fontFamily: '"SF Mono", "Menlo", "Monaco", monospace',
      fontWeight: "400",
      fontWeightBold: "600",
      scrollback: 10000,
      theme: {
        background: "#1a1b26",
        foreground: "#a9b1d6",
        cursor: "#c0caf5",
        selectionBackground: "#33467c",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    onReady?.(term.cols, term.rows);

    term.onData((data) => {
      connRef.current?.sendInput(data);
    });

    const handleResize = () => {
      fitAddon.fit();
      connRef.current?.resize(term.cols, term.rows);
    };
    window.addEventListener("resize", handleResize);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    return () => {
      window.removeEventListener("resize", handleResize);
      term.dispose();
      xtermRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Connect to PTY WebSocket
  useEffect(() => {
    connRef.current?.close();
    connRef.current = null;

    const conn = connectPty(ptyPid);
    connRef.current = conn;

    const decoder = new TextDecoder();
    conn.onOutput((data) => {
      const term = xtermRef.current;
      if (!term) return;
      const writeData = typeof data === "string" ? data : decoder.decode(data as Uint8Array);
      // Standard term.write() — Chromium handles rendering correctly
      term.write(writeData);
    });

    // Send initial resize
    const term = xtermRef.current;
    if (term) {
      conn.resize(term.cols, term.rows);
    }

    return () => {
      conn.close();
      connRef.current = null;
    };
  }, [ptyPid]);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      requestAnimationFrame(() => fitAddonRef.current?.fit());
    }
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <div ref={terminalRef} className="w-full h-full" />
    </div>
  );
}
