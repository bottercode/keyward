// keyward dashboard. Everything is built with textContent (file names are data, never markup).
const RISKS = ["critical", "high", "medium", "low"];
const COLOR = { critical: "var(--critical)", high: "var(--high)", medium: "var(--medium)", low: "var(--low)" };
const RISK_TEXT = {
  critical: "Readable by anyone right now",
  high: "Committed or in git history",
  medium: "Copies in chats, history or unignored files",
  low: "Stored the usual way",
};
const KIND = {
  browser: "Served to browsers",
  build: "Build output",
  "env-file": "Env file",
  source: "Source file",
  "git-history": "Git history",
  "ai-chat": "AI chat",
  "shell-history": "Shell history",
  "shell-config": "Shell config",
  "app-config": "App config",
};
const HOT_KINDS = new Set(["browser", "git-history"]);
const PAGE = 200;

const ui = {
  riskFilter: new Set(),
  query: "",
  open: new Set(),
  state: null,
  tab: "keys",
  /** Per-key action state, kept across re-renders: { checking, rotate: {plan, loading, error, result, applying}, confirmIgnore } */
  act: {},
  /** Spend rows waiting for a second click to confirm a freeze. */
  confirmFreeze: new Set(),
  spendBusy: false,
  spendMsg: "",
};
const act = (id) => (ui.act[id] ??= {});

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $ = (id) => document.getElementById(id);
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { "x-keyward": "1", ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res.json();
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let timer = null;
async function refresh() {
  clearTimeout(timer);
  try {
    ui.state = await api("/api/state");
    render();
    if (ui.state.scanning) timer = setTimeout(refresh, 600);
    else if (ui.state.watching.length) timer = setTimeout(refresh, 60_000);
  } catch (err) {
    $("error").hidden = false;
    $("error").textContent = `Lost the connection to keyward (${err.message}). Is it still running?`;
  }
}

async function rescan() {
  const home = $("home").checked ? "1" : "0";
  ui.state = await api(`/api/rescan?home=${home}`);
  render();
  refresh();
}

function render() {
  const s = ui.state;
  $("keys").hidden = ui.tab !== "keys";
  $("spend").hidden = ui.tab !== "spend";
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("on", t.dataset.tab === ui.tab);
  $("spend-dot").hidden = !s.spend?.providers.some((p) => p.keys.some((k) => k.spike && k.active));
  renderSpend();
  $("home").checked = s.home;
  $("rescan").disabled = s.scanning;
  $("scanning").hidden = !s.scanning;
  $("progress").textContent = s.progress ?? "";
  $("error").hidden = !s.error;
  if (s.error) $("error").textContent = s.error;

  const r = s.result;
  $("summary").hidden = !r;
  $("controls").hidden = !r || r.findings.length === 0;
  $("empty").hidden = !r || r.findings.length > 0 || s.scanning;
  if (!r) {
    $("list").replaceChildren();
    return;
  }
  renderSummary(r);
  renderChips(r);
  renderList(r);
  if (r.findings.length === 0) {
    $("empty-text").textContent = `Checked ${plural(r.stats.files, "file")}${r.stats.gitBlobs ? ` and ${plural(r.stats.gitBlobs, "past file version")}` : ""}.${s.home ? "" : " Tick “Include home folder” to check shell history and AI chats too."}`;
  }
}

function renderSummary(r) {
  $("tiles").replaceChildren(
    ...RISKS.map((risk) =>
      h(
        "button",
        {
          class: `tile${r.counts[risk] ? "" : " zero"}${ui.riskFilter.has(risk) ? " on" : ""}`,
          style: { "--c": COLOR[risk] },
          type: "button",
          onclick: () => {
            ui.riskFilter.has(risk) ? ui.riskFilter.delete(risk) : ui.riskFilter.add(risk);
            render();
          },
        },
        h("div", { class: "n" }, r.counts[risk]),
        h("div", { class: "l" }, risk[0].toUpperCase() + risk.slice(1)),
        h("div", { class: "d" }, RISK_TEXT[risk]),
      ),
    ),
  );
  const st = r.stats;
  const bits = [`Scanned ${st.roots.join(", ")}`, plural(st.files, "file")];
  if (st.gitBlobs) bits.push(`${plural(st.gitBlobs, "past file version")} in ${plural(st.gitRepos, "git repo")}`);
  if (st.homeFiles) bits.push(`${plural(st.homeFiles, "file")} in your home folder`);
  bits.push(`${(st.ms / 1000).toFixed(1)}s`);
  $("stats").textContent = bits.join(" · ");
}

function renderChips(r) {
  const kinds = new Map();
  for (const f of r.findings) for (const l of f.locations) kinds.set(l.kind, (kinds.get(l.kind) ?? 0) + 1);
  const order = Object.keys(KIND).filter((k) => kinds.has(k));
  $("chips").replaceChildren(
    ...order.map((k) =>
      h(
        "button",
        {
          class: `chip${ui.query === `kind:${k}` ? " on" : ""}`,
          type: "button",
          onclick: () => {
            ui.query = ui.query === `kind:${k}` ? "" : `kind:${k}`;
            $("search").value = ui.query;
            render();
          },
        },
        `${KIND[k]} · ${kinds.get(k)}`,
      ),
    ),
  );
}

function matches(f) {
  if (ui.riskFilter.size && !ui.riskFilter.has(f.risk)) return false;
  const q = ui.query.trim().toLowerCase();
  if (!q) return true;
  if (q.startsWith("kind:")) return f.locations.some((l) => l.kind === q.slice(5));
  const hay = [f.providerName, f.masked, ...f.locations.flatMap((l) => [l.path, l.project ?? "", l.varName ?? "", l.app ?? ""])].join(" ").toLowerCase();
  return hay.includes(q);
}

function renderList(r) {
  const shown = r.findings.filter(matches);
  const cards = shown.slice(0, PAGE).map(card);
  if (shown.length > PAGE) cards.push(h("div", { class: "more" }, `${shown.length - PAGE} more. Narrow the filter to see them.`));
  if (shown.length === 0 && r.findings.length) cards.push(h("div", { class: "more" }, "Nothing matches this filter."));
  $("list").replaceChildren(...cards);
}

function card(f) {
  const open = ui.open.has(f.id);
  const top = f.reasons[0];
  const el = h(
    "article",
    { class: `card ${f.risk}${open ? " open" : ""}`, style: { "--c": COLOR[f.risk] } },
    h(
      "button",
      {
        class: "row",
        type: "button",
        "aria-expanded": String(open),
        onclick: () => {
          ui.open.has(f.id) ? ui.open.delete(f.id) : ui.open.add(f.id);
          el.classList.toggle("open");
        },
      },
      h("span", { class: `badge ${f.risk}`, style: { "--c": COLOR[f.risk] } }, f.risk),
      h("span", { class: "provider", title: f.providerName }, f.providerName),
      h("span", { class: "masked" }, f.masked),
      h("span", { class: "why", title: top?.text ?? "" }, top?.text ?? ""),
      h(
        "span",
        { class: "places" },
        plural(f.locations.length, "place"),
        ui.state.verified[f.id] ? h("span", { class: `pill ${ui.state.verified[f.id].status}` }, STATUS[ui.state.verified[f.id].status]) : null,
        h("span", { class: "chev" }, "›"),
      ),
    ),
    detail(f),
  );
  return el;
}

function detail(f) {
  return h(
    "div",
    { class: "detail" },
    h("h4", {}, "Why"),
    h(
      "ul",
      { class: "reasons" },
      f.reasons.map((r) =>
        h("li", { style: { "--c": COLOR[r.risk] } }, h("span", { class: "mark" }, r.risk === "low" ? "·" : "✗"), h("span", {}, r.text)),
      ),
    ),
    f.note ? h("div", { class: "note" }, f.note) : null,
    h("h4", {}, "Fix"),
    h("ol", { class: "fix" }, f.fix.map((step) => h("li", {}, step))),
    actions(f),
    checkResult(f),
    act(f.id).rotate ? rotatePanel(f) : null,
    h("h4", {}, `Where (${f.locations.length})`),
    h("table", { class: "locs" }, h("tbody", {}, f.locations.map(locRow))),
  );
}

function locRow(l) {
  const project = l.project ? l.project.split("/").pop() + "/" : "";
  const lines = l.lines.length ? `:${l.lines.join(",")}` : "";
  const meta = [];
  if (l.varName) meta.push(l.varName);
  if (l.app) meta.push(l.app);
  if (l.commit) meta.push(`commit ${l.commit}`);
  if (l.git) meta.push(l.git.tracked ? (l.git.hasRemote ? "committed, pushed" : "committed") : l.git.ignored ? "gitignored" : "not ignored");
  if (l.count > 1) meta.push(`${l.count}×`);
  return h(
    "tr",
    {},
    h("td", { class: "kind" }, h("span", { class: HOT_KINDS.has(l.kind) ? "hot" : "" }, KIND[l.kind] ?? l.kind)),
    h("td", { class: "path", title: (l.project ? l.project + "/" : "") + l.path }, h("span", { class: "proj" }, project), l.path + lines),
    h("td", { class: "meta" }, meta.join(" · ")),
  );
}

// ---- actions on a key ----

const STATUS = { live: "still works", dead: "revoked", unknown: "not checked" };
const CHECKABLE = new Set(["openai", "anthropic", "openrouter", "google", "groq", "xai", "huggingface", "replicate", "stripe", "github", "npm", "slack", "sendgrid"]);

function rerender() {
  if (ui.state?.result) renderList(ui.state.result);
}

function actions(f) {
  const a = act(f.id);
  return h(
    "div",
    { class: "actions-row" },
    CHECKABLE.has(f.provider)
      ? h("button", { class: "btn", type: "button", disabled: a.checking, title: `Sends the key to ${f.providerName} only`, onclick: () => check(f) }, a.checking ? "Checking…" : "Check if it still works")
      : null,
    h("button", { class: "btn primary", type: "button", onclick: () => openRotate(f) }, "Rotate everywhere…"),
    f.revokeUrl ? h("a", { class: "btn revoke", href: f.revokeUrl, target: "_blank", rel: "noopener noreferrer" }, `${f.providerName} keys ↗`) : null,
    h(
      "button",
      { class: `btn ${a.confirmIgnore ? "confirm" : "danger"}`, type: "button", onclick: () => ignore(f) },
      a.confirmIgnore ? "Click again to ignore" : "Ignore",
    ),
  );
}

function checkResult(f) {
  const v = ui.state.verified[f.id];
  const a = act(f.id);
  if (a.checkError) return h("div", { class: "check-result" }, h("span", { class: "pill unknown" }, "error"), a.checkError);
  if (!v) return null;
  return h("div", { class: "check-result" }, h("span", { class: `pill ${v.status}` }, STATUS[v.status]), v.detail, v.checked ? h("span", { class: "places" }, `asked ${new URL(v.checked).host} only`) : null);
}

async function check(f) {
  const a = act(f.id);
  a.checking = true;
  delete a.checkError;
  rerender();
  try {
    ui.state.verified[f.id] = await api(`/api/verify?id=${f.id}`);
  } catch (err) {
    a.checkError = err.message;
  }
  a.checking = false;
  rerender();
}

async function ignore(f) {
  const a = act(f.id);
  if (!a.confirmIgnore) {
    a.confirmIgnore = true;
    rerender();
    setTimeout(() => {
      a.confirmIgnore = false;
      rerender();
    }, 4000);
    return;
  }
  await post("/api/ignore", { id: f.id });
  ui.open.delete(f.id);
  await refresh();
}

async function openRotate(f) {
  const a = act(f.id);
  a.rotate = { loading: true };
  rerender();
  try {
    a.rotate = { plan: await api(`/api/rotate/plan?id=${f.id}`) };
  } catch (err) {
    a.rotate = { error: err.message };
  }
  rerender();
}

const STEP_MARK = { done: ["✓", "ok"], failed: ["✗", "bad"], skipped: ["·", ""] };

function stepList(steps) {
  return h(
    "ul",
    { class: "steps" },
    steps.map((s) => {
      const [mark, cls] = s.status ? STEP_MARK[s.status] : s.kind === "manual" ? ["→", "todo"] : ["·", ""];
      return h("li", {}, h("span", { class: cls }, mark), h("span", { class: "t" }, s.target), h("span", { class: "a" }, s.action));
    }),
  );
}

function rotatePanel(f) {
  const r = act(f.id).rotate;
  const close = h("button", { class: "btn", type: "button", onclick: () => { delete act(f.id).rotate; rerender(); } }, "Close");
  if (r.loading) return h("div", { class: "rotate" }, h("div", { class: "sub" }, "Finding everywhere this key lives (checks Vercel, Railway and GitHub through your own CLIs)…"));
  if (r.error) return h("div", { class: "rotate" }, h("div", { class: "msg bad" }, r.error), close);
  if (r.result) {
    return h(
      "div",
      { class: "rotate" },
      h("h5", {}, "Done"),
      h("div", { class: "sub" }, "Check your apps work with the new key, then delete the old one at the provider."),
      stepList(r.result),
      f.revokeUrl ? h("a", { class: "btn primary", href: f.revokeUrl, target: "_blank", rel: "noopener noreferrer" }, `Delete the old key at ${f.providerName} ↗`) : null,
      " ",
      close,
    );
  }
  const input = h("input", { type: "password", placeholder: `Paste the new ${f.providerName} key`, autocomplete: "off", spellcheck: "false" });
  const apply = async () => {
    r.applying = true;
    r.applyError = "";
    rerender();
    try {
      const out = await post("/api/rotate", { id: f.id, newKey: input.value });
      act(f.id).rotate = { result: out.steps };
    } catch (err) {
      r.applying = false;
      r.applyError = err.message;
    }
    rerender();
    if (!act(f.id).rotate?.applyError) setTimeout(refresh, 300);
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && apply());
  return h(
    "div",
    { class: "rotate" },
    h("h5", {}, `Rotate ${f.providerName} ${f.masked}`),
    h(
      "div",
      { class: "sub" },
      "1. Create a new key",
      f.revokeUrl ? [" at ", h("a", { href: f.revokeUrl, target: "_blank", rel: "noopener noreferrer" }, new URL(f.revokeUrl).host)] : "",
      " and keep the old one for now. 2. Paste it below: keyward puts it everywhere listed. 3. Delete the old key.",
    ),
    stepList(r.plan.steps),
    h("div", { class: "newkey" }, input, h("button", { class: "btn primary", type: "button", disabled: r.applying, onclick: apply }, r.applying ? "Rotating…" : "Put it everywhere"), close),
    r.applyError ? h("div", { class: "msg bad" }, r.applyError) : null,
    h("div", { class: "sub", style: { "margin-top": "8px", "margin-bottom": "0" } }, "The new key goes from this page to keyward on this machine, into your files, and to the platforms above through your CLIs. Nowhere else."),
  );
}

// ---- spend ----

function money(v, unit) {
  if (unit === "USD/day") return `$${v.toFixed(2)}/day`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M tok/h`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K tok/h`;
  return `${Math.round(v)} tok/h`;
}

function spark(series, spike) {
  if (!series?.length) return null;
  const w = 96;
  const hgt = 22;
  const max = Math.max(1, ...series);
  const pts = series.map((v, i) => `${((i / (series.length - 1)) * w).toFixed(1)},${(hgt - 2 - (v / max) * (hgt - 4)).toFixed(1)}`).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(hgt));
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", pts);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", spike ? "#ff5a4e" : "#9a9ca3");
  line.setAttribute("stroke-width", "1.5");
  svg.append(line);
  return svg;
}

const PROVIDER_NAME = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };

function renderSpend() {
  const s = ui.state;
  const root = $("spend");
  if (!s.watching.length) {
    root.replaceChildren(
      h(
        "div",
        { class: "explain" },
        h("h3", {}, "Watch spend per key, and freeze a key that spikes"),
        h("p", {}, "A stolen key shows up as usage you didn't make. keyward checks each provider's usage per key every 5 minutes and flags a key running far above its normal level. Freezing turns the key off at the provider: reversible for Anthropic and OpenRouter."),
        h("p", {}, "It needs an admin key per provider, read from the environment when keyward starts (never stored):"),
        h(
          "table",
          {},
          h("tbody", {},
            h("tr", {}, h("td", {}, h("code", {}, "ANTHROPIC_ADMIN_KEY")), h("td", {}, "Console → Settings → Admin keys (organizations only)")),
            h("tr", {}, h("td", {}, h("code", {}, "OPENAI_ADMIN_KEY")), h("td", {}, "Platform → Settings → Admin keys. Freezing deletes the key (OpenAI can't disable one), so it needs --allow-delete")),
            h("tr", {}, h("td", {}, h("code", {}, "OPENROUTER_MANAGEMENT_KEY")), h("td", {}, "Settings → Management keys")),
          ),
        ),
        h("pre", {}, "ANTHROPIC_ADMIN_KEY=… npx keyward\n# or, in a terminal, without the dashboard:\nANTHROPIC_ADMIN_KEY=… npx keyward watch --freeze"),
      ),
    );
    return;
  }
  const spend = s.spend;
  const head = h(
    "div",
    { class: "spend-head" },
    spend ? `Checked ${new Date(spend.at).toLocaleTimeString()} · every 5 minutes while this page's server runs` : "Checking…",
    h(
      "button",
      {
        class: "btn",
        type: "button",
        disabled: ui.spendBusy,
        onclick: async () => {
          ui.spendBusy = true;
          renderSpend();
          try {
            s.spend = await api("/api/spend/refresh");
          } finally {
            ui.spendBusy = false;
            render();
          }
        },
      },
      ui.spendBusy ? "Checking…" : "Check now",
    ),
  );
  if (!spend) return root.replaceChildren(head);
  root.replaceChildren(head, ui.spendMsg ? h("div", { class: "msg" }, ui.spendMsg) : "", ...spend.providers.map((p) => providerBlock(p, spend)));
}

function providerBlock(p, spend) {
  const name = PROVIDER_NAME[p.provider];
  if (!p.ok) return h("div", { class: "provider-block" }, h("h3", {}, name), h("div", { class: "err" }, p.error));
  const spikes = p.keys.filter((k) => k.spike).length;
  return h(
    "div",
    { class: "provider-block" },
    h("h3", {}, name, h("span", { class: "places" }, `${plural(p.keys.length, "key")}${spikes ? ` · ${spikes} spiking` : " · nothing unusual"}`)),
    h(
      "table",
      { class: "spend" },
      h("thead", {}, h("tr", {}, ["Key", "", "Now", "Normal", "Last 24h", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, p.keys.map((k) => keyRow(p.provider, k, spend))),
    ),
  );
}

function keyRow(provider, k, spend) {
  const tag = `${provider}:${k.id}`;
  const local = spend.local?.[tag] ?? [];
  const confirming = ui.confirmFreeze.has(tag);
  const freeze = async (frozen) => {
    if (frozen && !confirming) {
      ui.confirmFreeze.add(tag);
      renderSpend();
      setTimeout(() => {
        ui.confirmFreeze.delete(tag);
        renderSpend();
      }, 4000);
      return;
    }
    ui.confirmFreeze.delete(tag);
    try {
      const r = await post("/api/freeze", { provider, id: k.id, project: k.project, frozen });
      ui.spendMsg = `${k.name}: ${r.message}`;
    } catch (err) {
      ui.spendMsg = `${k.name}: ${err.message}`;
    }
    await refresh();
  };
  const verb = provider === "openai" ? "Delete" : "Freeze";
  return h(
    "tr",
    { class: k.spike && k.active ? "spike" : "" },
    h("td", {}, h("div", { class: k.active ? "" : "off" }, k.name, k.active ? "" : " (frozen)"), h("div", { class: "hint" }, k.hint)),
    h(
      "td",
      {},
      k.spike ? h("span", { class: "pill live" }, "spike") : null,
      local.length
        ? h("button", { class: "local", type: "button", title: "Found on this machine", onclick: () => { ui.tab = "keys"; ui.query = ""; ui.open = new Set(local); render(); } }, ` on this machine (${local.length})`)
        : null,
    ),
    h("td", { class: "num" }, money(k.current, k.unit)),
    h("td", { class: "num places" }, money(k.baseline, k.unit)),
    h("td", {}, spark(k.series, k.spike)),
    h(
      "td",
      { style: { "text-align": "right" } },
      !k.canFreeze
        ? h("span", { class: "places", title: "OpenAI keys can only be deleted; start keyward with --allow-delete to allow it" }, provider === "openai" ? "alert only" : "")
        : k.active
          ? h("button", { class: `btn ${confirming ? "confirm" : "danger"}`, type: "button", onclick: () => freeze(true) }, confirming ? `Click again to ${verb.toLowerCase()}` : verb)
          : k.reversible
            ? h("button", { class: "btn", type: "button", onclick: () => freeze(false) }, "Unfreeze")
            : null,
    ),
  );
}

for (const t of document.querySelectorAll(".tab")) {
  t.addEventListener("click", () => {
    ui.tab = t.dataset.tab;
    render();
  });
}

$("rescan").addEventListener("click", rescan);
$("home").addEventListener("change", rescan);
$("search").addEventListener("input", (e) => {
  ui.query = e.target.value;
  if (ui.state?.result) {
    renderChips(ui.state.result);
    renderList(ui.state.result);
  }
});
refresh();
