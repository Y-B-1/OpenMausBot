import { useState } from "react";
import { ShieldCheck } from "lucide-react";

import { useStore } from "@/state/store";

// P7: shown only when org mode is ON and there is no session. Solo mode
// (the default) never renders this — the app stays login-free.
export function LoginGate() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app">
      <form
        className="flex w-[340px] flex-col gap-3 rounded-2xl border border-hairline/50 bg-panel px-6 py-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) dispatch({ type: "loginOrg", name: name.trim(), password });
        }}
      >
        <div className="flex items-center gap-2.5">
          <ShieldCheck size={18} className="text-accent" />
          <div className="text-[16px] font-semibold text-ink">Sign in</div>
        </div>
        <div className="text-[12.5px] leading-relaxed text-ink-secondary">
          This workspace runs in org mode. Your first password sets itself on first use.
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          autoFocus
          className="rounded-lg border border-hairline/60 bg-inset px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-secondary/60"
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder="Password"
          className="rounded-lg border border-hairline/60 bg-inset px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-secondary/60"
        />
        {state.error && <div className="text-[12px] text-danger">{state.error}</div>}
        <button
          type="submit"
          disabled={!name.trim()}
          className="rounded-lg bg-accent px-3 py-2 text-[13.5px] font-medium text-white disabled:opacity-50"
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
