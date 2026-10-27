"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { captureAction } from "@/app/actions";

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => RecognitionLike;

/**
 * One-field capture with optional voice input. The same server action as the
 * workspace, so a mobile capture goes through extraction, grounding, facts,
 * commitments, and the Walrus write — no shortcut path.
 */
export function QuickCapture({ initialText }: { initialText: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialText);
  const [listening, setListening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (initialText) setValue(initialText);
  }, [initialText]);

  function startVoice() {
    setError(null);
    const w = window as unknown as {
      SpeechRecognition?: RecognitionCtor;
      webkitSpeechRecognition?: RecognitionCtor;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      setError("Voice input isn't available in this browser — type instead.");
      return;
    }
    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i]?.[0]?.transcript ?? "";
      }
      if (transcript.trim()) setValue(transcript.trim());
    };
    recognition.onerror = () => {
      setListening(false);
      setError("Voice input stopped — you can type the rest.");
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  function stopVoice() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  function save() {
    const text = value.trim();
    if (!text || isPending) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await captureAction(text);
      if (res.ok) {
        setMessage(res.summary);
        setValue("");
        router.refresh();
        inputRef.current?.focus();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="rounded-2xl border border-ink/10 bg-white p-4 shadow-sm">
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
        rows={5}
        autoFocus
        placeholder="e.g. Met Sarah Chen — founder at Nimbus, hiring React engineers. Or: my passport expires in March."
        className="w-full resize-none rounded-xl border border-ink/10 bg-paper px-4 py-3 text-sm focus:border-accent focus:outline-none"
      />

      {message && (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </p>
      )}
      {error && <p className="mt-2 text-sm text-accent">{error}</p>}

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          onClick={listening ? stopVoice : startVoice}
          disabled={isPending}
          className={[
            "rounded-lg border px-3 py-2 text-xs font-medium transition disabled:opacity-40",
            listening
              ? "border-accent/40 bg-accent/5 text-accent"
              : "border-ink/15 text-ink/60 hover:border-accent/40",
          ].join(" ")}
        >
          {listening ? "● Listening — tap to stop" : "🎙 Voice"}
        </button>
        <button
          onClick={save}
          disabled={isPending || !value.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? "Saving…" : "Remember this"}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-ink/35">
        ⌘/Ctrl + Enter · voice is transcribed in your browser
      </p>
    </div>
  );
}
