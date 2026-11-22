// keyward dashboard. Built with textContent only: file names and paths are data, never markup.

// A key's risk is how far it has travelled. Ordered from contained to public.
const REACH = [
  { risk: "low", name: "This machine", desc: "Stored the usual way, in a gitignored file", c: "var(--r1)" },
  { risk: "medium", name: "Spread around", desc: "Copied into chats, history or files git could pick up", c: "var(--r2)" },
  { risk: "high", name: "Your repo", desc: "Everyone with access to the repo has it", c: "var(--r3)" },
  { risk: "critical", name: "The internet", desc: "Anyone visiting your site can read it", c: "var(--r4)" },
];
const LEVEL = Object.fromEntries(REACH.map((r, i) => [r.risk, i]));
const reachOf = (risk) => REACH[LEVEL[risk]];

const KIND = {
  browser: "Browser code",
  build: "Build output",
  "env-file": "Env file",
  source: "Source code",
  "git-history": "Git history",
  "ai-chat": "AI chat",
  "shell-history": "Shell history",
  "shell-config": "Shell config",
  "app-config": "App config",
};
const HOT = new Set(["browser", "git-history"]);
const CHECKABLE = new Set(["openai", "anthropic", "openrouter", "google", "groq", "xai", "huggingface", "replicate", "stripe", "github", "npm", "slack", "sendgrid"]);
const STATUS = { live: "Still works", dead: "Revoked", unknown: "Couldn't check" };
const PAGE = 200;

const ui = {
  tab: "keys",
  reach: new Set(),
  kind: null,
  query: "",
  open: new Set(),
  state: null,
  act: {},
  lastScan: null,
  animate: false,
  confirmFreeze: new Set(),
  spendBusy: false,
  spendMsg: "",
};
const act = (id) => (ui.act[id] ??= {});

// ---------- helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false || c === "") continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
const plural = (n, one, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const external = (href, label, cls = "btn") => h("a", { class: cls, href, target: "_blank", rel: "noopener noreferrer" }, label);

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { "x-keyward": "1", ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res.json();
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------- state ----------

let timer = null;
async function refresh() {
  clearTimeout(timer);
  try {
    ui.state = await api("/api/state");
    $("error").hidden = true;
    const stamp = ui.state.result ? `${ui.state.result.stats.ms}:${ui.state.result.findings.length}` : null;
    if (stamp && stamp !== ui.lastScan) {
      ui.animate = ui.lastScan !== null || !ui.state.scanning;
      ui.lastScan = stamp;
      setTimeout(() => (ui.animate = false), 1500);
    }
    render();
    if (ui.state.scanning) timer = setTimeout(refresh, 600);
    else if (ui.state.watching.length) timer = setTimeout(refresh, 60_000);
  } catch (err) {
    $("error").hidden = false;
    $("error").textContent = `Lost contact with keyward on this machine (${err.message}). Is it still running? Start it again with: keyward`;
  }
}

async function rescan() {
  ui.state = await api(`/api/rescan?home=${$("home").checked ? "1" : "0"}`);
  render();
  refresh();
}

// ---------- render ----------

function render() {
  const s = ui.state;
  for (const t of document.querySelectorAll(".tab")) {
    if (t.dataset.tab === ui.tab) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  }
  $("keys").hidden = ui.tab !== "keys";
  $("spend").hidden = ui.tab !== "spend";
  $("spend-dot").hidden = !s.spend?.providers.some((p) => p.keys.some((k) => k.spike && k.active));
  $("home").checked = s.home;
  $("rescan").disabled = s.scanning;
  $("rescan").textContent = s.scanning ? "Scanning…" : "Rescan";
  $("progress-line").hidden = !s.scanning;
  if (s.error) {
    $("error").hidden = false;
    $("error").textContent = `The scan failed: ${s.error}`;
  }
  renderVerdict();
  renderKeys();
  renderSpend();
}

function renderVerdict() {
  const s = ui.state;
  const r = s.result;
  const title = $("verdict-title");
  const sub = $("verdict-sub");
  if (!r) {
    title.textContent = "Looking for keys…";
    sub.textContent = s.progress ? `${s.progress}.` : "";
    return;
  }
  const c = r.counts;
  const total = r.findings.length;
  const n = (k, one, many) => (k === 1 ? one : `${k} ${many}`);
  if (c.critical) title.textContent = `${n(c.critical, "One key that", "keys")} anyone on the internet can read.`;
  else if (c.high) title.textContent = `${n(c.high, "One key", "keys")} everyone with access to your repos has.`;
  else if (c.medium) title.textContent = `${n(c.medium, "One key has", "keys have")} spread to places ${c.medium === 1 ? "it" : "they"} shouldn't be.`;
  else if (total) title.textContent = "Every key is stored the usual way.";
  else title.textContent = "No keys found.";

  const st = r.stats;
  const where = [plural(st.files, "file")];
  if (st.gitBlobs) where.push(`${plural(st.gitBlobs, "past file version")} in git`);
  if (st.homeFiles) where.push("your home folder");
  const list = where.length > 1 ? `${where.slice(0, -1).join(", ")} and ${where.at(-1)}` : where[0];
  let text = total ? `${plural(total, "key")} across ${list}.` : `Checked ${list}.`;
  if (c.critical + c.high + c.medium) text += " The worst is at the top, and each one says what to do.";
  else if (!s.home) text += " Include your home folder to check shell history and AI chats too.";
  if (st.ignored) text += ` ${plural(st.ignored, "key")} ignored.`;
  if (s.scanning) text = `${s.progress ?? "Scanning"}…`;
  sub.textContent = text;
}

function renderKeys() {
  const r = ui.state.result;
  $("reach").hidden = !r || r.findings.length === 0;
  $("controls").hidden = !r || r.findings.length === 0;
  if (!r) return $("list").replaceChildren();
  renderReach(r);
  renderChips(r);
  renderList(r);
}

function renderReach(r) {
  $("reach").replaceChildren(
    ...REACH.map((step) => {
      const count = r.counts[step.risk];
      const on = ui.reach.has(step.risk);
      return h(
        "button",
        {
          type: "button",
          class: `reach-seg${count ? " has" : " zero"}`,
          style: { "--c": step.c },
          "aria-pressed": String(on),
          onclick: () => {
            on ? ui.reach.delete(step.risk) : ui.reach.add(step.risk);
            renderKeys();
          },
        },
        h("div", { class: "n" }, count),
        h("div", { class: "name" }, step.name),
        h("div", { class: "desc" }, step.desc),
      );
    }),
  );
}

function renderChips(r) {
  const kinds = new Map();
  for (const f of r.findings) for (const kind of new Set(f.locations.map((l) => l.kind))) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  $("chips").replaceChildren(
    ...Object.keys(KIND)
      .filter((k) => kinds.has(k))
      .map((k) =>
        h(
          "button",
          {
            type: "button",
            class: "chip",
            "aria-pressed": String(ui.kind === k),
            onclick: () => {
              ui.kind = ui.kind === k ? null : k;
              renderKeys();
            },
          },
          KIND[k],
          h("span", { class: "count" }, kinds.get(k)),
        ),
      ),
  );
}

function matches(f) {
  if (ui.reach.size && !ui.reach.has(f.risk)) return false;
  if (ui.kind && !f.locations.some((l) => l.kind === ui.kind)) return false;
  const q = ui.query.trim().toLowerCase();
  if (!q) return true;
  return [f.providerName, f.masked, ...f.locations.flatMap((l) => [l.path, l.project ?? "", l.varName ?? "", l.app ?? ""])]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function renderList(r) {
  const shown = r.findings.filter(matches);
  const rows = shown.slice(0, PAGE).map((f, i) => keyItem(f, i));
  if (shown.length > PAGE) rows.push(h("div", { class: "more" }, `${shown.length - PAGE} more keys. Narrow the search to see them.`));
  if (r.findings.length === 0) {
    rows.push(h("div", { class: "empty-hint" }, ui.state.home ? "Nothing to fix. Run keyward hook install in your repos to keep it that way." : "Nothing in these folders. Tick “Include home folder” to also check shell history, app configs and AI chat transcripts."));
  } else if (shown.length === 0) {
    rows.push(h("div", { class: "empty-hint" }, "No keys match these filters."));
  }
  const list = $("list");
  list.classList.toggle("fill-in", ui.animate);
  list.replaceChildren(...rows);
}

function meter(risk, row) {
  const level = LEVEL[risk];
  const reach = REACH[level];
  return h(
    "div",
    { class: "meter", style: { "--c": reach.c, "--row": String(row) } },
    h("div", { class: "track", "aria-hidden": "true" }, REACH.map((_, i) => h("span", { class: i <= level ? "on" : "", style: { "--i": String(i) } }))),
    h("div", { class: "meter-label" }, reach.name),
  );
}

function keyItem(f, row) {
  const open = ui.open.has(f.id);
  const v = ui.state.verified[f.id];
  const item = h(
    "article",
    { class: `key${open ? " open" : ""}` },
    h(
      "button",
      {
        type: "button",
        class: "key-row",
        "aria-expanded": String(open),
        onclick: () => {
          ui.open.has(f.id) ? ui.open.delete(f.id) : ui.open.add(f.id);
          rerender();
        },
      },
      h(
        "div",
        { class: "key-id" },
        h("div", { class: "key-name" }, h("strong", {}, f.providerName), h("span", { class: "masked" }, f.masked)),
        h("div", { class: "key-why" }, f.reasons[0]?.text ?? ""),
      ),
      meter(f.risk, row),
      h("div", { class: "key-side" }, plural(f.locations.length, "place"), v ? h("span", { class: `status ${v.status}` }, STATUS[v.status]) : null),
    ),
    open ? body(f) : null,
  );
  return item;
}

function body(f) {
  return h(
    "div",
    { class: "key-body" },
    h(
      "div",
      { class: "body-grid" },
      h(
        "div",
        {},
        h("h3", {}, "Why it's exposed"),
        h("ul", { class: "reasons" }, f.reasons.map((r) => h("li", { style: { "--c": reachOf(r.risk).c } }, h("span", { class: "dot" }), h("span", {}, r.text)))),
        f.note ? h("p", { class: "note" }, f.note) : null,
        h("h3", {}, "What to do"),
        h("ol", { class: "fix" }, f.fix.map((s) => h("li", {}, s))),
      ),
      h(
        "div",
        {},
        h("h3", {}, `Where it lives (${f.locations.length})`),
        h("table", { class: "where" }, h("tbody", {}, f.locations.map(whereRow))),
      ),
    ),
    actions(f),
    checkResult(f),
    act(f.id).rotate ? rotatePanel(f) : null,
  );
}

/** A path that wraps at slashes, not mid-word. */
function pathText(p) {
  const parts = p.split("/");
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [part + "/", h("wbr")] : [part]));
}

function whereRow(l) {
  const project = l.project ? `${l.project.split("/").pop()}/` : "";
  const lines = l.lines.length ? `:${l.lines.join(",")}` : "";
  const meta = [];
  if (l.varName) meta.push(l.varName);
  if (l.app) meta.push(l.app);
  if (l.commit) meta.push(`commit ${l.commit}`);
  if (l.git) meta.push(l.git.tracked ? (l.git.hasRemote ? "committed and pushed" : "committed") : l.git.ignored ? "gitignored" : "not in .gitignore");
  if (l.count > 1) meta.push(`${l.count} times`);
  return h(
    "tr",
    {},
    h("td", { class: `kind${HOT.has(l.kind) ? " hot" : ""}` }, KIND[l.kind] ?? l.kind),
    h(
      "td",
      { class: "path", title: (l.project ? `${l.project}/` : "") + l.path },
      h("span", { class: "proj" }, project),
      pathText(l.path + lines),
      meta.length ? h("span", { class: "meta" }, meta.join(", ")) : null,
    ),
  );
}

// ---------- actions ----------

function rerender() {
  if (ui.state?.result) renderList(ui.state.result);
}

function actions(f) {
  const a = act(f.id);
  return h(
    "div",
    { class: "actions" },
    h("button", { type: "button", class: "btn btn-primary", onclick: () => openRotate(f) }, "Rotate everywhere"),
    CHECKABLE.has(f.provider)
      ? h("button", { type: "button", class: "btn", disabled: a.checking, title: `Asks ${f.providerName}, and only ${f.providerName}`, onclick: () => check(f) }, a.checking ? "Checking…" : "Check if it still works")
      : null,
    f.revokeUrl ? external(f.revokeUrl, `Open ${f.providerName} keys`) : null,
    h("button", { type: "button", class: `btn push ${a.confirmIgnore ? "btn-confirm" : "btn-quiet"}`, title: "Stop reporting this key (adds it to ~/.keywardignore)", onclick: () => ignore(f) }, a.confirmIgnore ? "Click again to ignore" : "Ignore"),
  );
}

function checkResult(f) {
  const v = ui.state.verified[f.id];
  const a = act(f.id);
  if (a.checkError) return h("div", { class: "check-result" }, h("strong", {}, "Couldn't check."), a.checkError);
  if (!v) return null;
  return h(
    "div",
    { class: "check-result" },
    h("strong", { class: v.status }, `${STATUS[v.status]}.`),
    h("span", {}, v.detail),
    v.checked ? h("span", { class: "asked" }, `Asked ${new URL(v.checked).host} only`) : null,
  );
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
  act(f.id).rotate = { loading: true };
  rerender();
  try {
    act(f.id).rotate = { plan: await api(`/api/rotate/plan?id=${f.id}`) };
  } catch (err) {
    act(f.id).rotate = { error: err.message };
  }
  rerender();
  document.querySelector(".rotate input")?.focus();
}

function stepList(steps) {
  return h(
    "ul",
    { class: "steps" },
    steps.map((s) => {
      // By-hand steps stay marked as to-do even after the rest has run.
      const state = s.kind === "manual" ? "manual" : (s.status ?? "todo");
      const mark = { done: "✓", failed: "✕", skipped: "–", manual: "!", todo: "○" }[state];
      return h("li", {}, h("span", { class: `mark ${state}` }, mark), h("span", { class: "target" }, s.target), h("span", { class: "action" }, s.action));
    }),
  );
}

function rotatePanel(f) {
  const r = act(f.id).rotate;
  const close = h("button", { type: "button", class: "btn btn-quiet", onclick: () => { delete act(f.id).rotate; rerender(); } }, "Close");
  if (r.loading) return h("div", { class: "rotate" }, h("p", { class: "lede" }, "Finding every place this key lives, including Vercel, Railway and GitHub through your own CLIs…"));
  if (r.error) return h("div", { class: "rotate" }, h("p", { class: "msg bad" }, r.error), close);
  if (r.result) {
    const failed = r.result.filter((s) => s.status === "failed").length;
    return h(
      "div",
      { class: "rotate" },
      h("h4", {}, failed ? `Rotated, with ${plural(failed, "step")} to finish by hand` : "Rotated"),
      h("p", { class: "lede" }, "Make sure your apps work with the new key, then delete the old one. Until it's deleted, anyone holding it can still use it."),
      stepList(r.result),
      h("div", { class: "actions" }, f.revokeUrl ? external(f.revokeUrl, `Delete the old key at ${f.providerName}`, "btn btn-primary") : null, close),
    );
  }
  const input = h("input", { type: "password", placeholder: `Paste the new ${f.providerName} key`, autocomplete: "off", spellcheck: "false", "aria-label": `New ${f.providerName} key` });
  const apply = async () => {
    r.applying = true;
    r.applyError = "";
    rerender();
    try {
      const out = await post("/api/rotate", { id: f.id, newKey: input.value });
      act(f.id).rotate = { result: out.steps };
      setTimeout(refresh, 400);
    } catch (err) {
      r.applying = false;
      r.applyError = err.message;
    }
    rerender();
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && apply());
  return h(
    "div",
    { class: "rotate" },
    h("h4", {}, `Rotate ${f.providerName} ${f.masked}`),
    h(
      "p",
      { class: "lede" },
      "Create a new key",
      f.revokeUrl ? [" at ", h("a", { href: f.revokeUrl, target: "_blank", rel: "noopener noreferrer" }, new URL(f.revokeUrl).host)] : "",
      " and keep the old one for now. Paste it here and keyward puts it in every place below. Then delete the old key.",
    ),
    stepList(r.plan.steps),
    h("div", { class: "newkey" }, input, h("button", { type: "button", class: "btn btn-primary", disabled: r.applying, onclick: apply }, r.applying ? "Rotating…" : "Rotate"), close),
    r.applyError ? h("p", { class: "msg bad" }, r.applyError) : null,
    h("p", { class: "fine" }, "The new key goes from this page to keyward on this machine, into your files, and to the platforms above through their CLIs. Nowhere else."),
  );
}

// ---------- spend ----------

const PROVIDER = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter" };

function amount(v, unit) {
  if (unit === "USD/day") return `$${v.toFixed(2)} a day`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M tokens/h`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K tokens/h`;
  return `${Math.round(v)} tokens/h`;
}

function spark(series, spike) {
  if (!series?.length) return h("div", { class: "num faint" }, "Daily totals only");
  const w = 110;
  const ht = 26;
  const max = Math.max(1, ...series);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(ht));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Usage over the last 24 hours");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", series.map((v, i) => `${((i / (series.length - 1)) * (w - 2) + 1).toFixed(1)},${(ht - 3 - (v / max) * (ht - 6)).toFixed(1)}`).join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", spike ? "#f0474f" : "#8a90a0");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linejoin", "round");
  svg.append(line);
  return svg;
}

function renderSpend() {
  const s = ui.state;
  const root = $("spend");
  if (!s.watching.length) {
    root.replaceChildren(
      h("section", { class: "verdict" }, h("h1", {}, "A stolen key shows up as spending you didn't do."), h("p", { class: "verdict-sub" }, "keyward can watch usage per key, flag a key running far above its normal level, and freeze it at the provider.")),
      h(
        "section",
        { class: "setup" },
        h("p", {}, "It needs an admin key for each provider you want watched. keyward reads them from the environment when it starts and never writes them anywhere."),
        h(
          "table",
          {},
          h(
            "tbody",
            {},
            h("tr", {}, h("td", {}, "ANTHROPIC_ADMIN_KEY"), h("td", {}, "Anthropic Console, Settings, Admin keys. Freezing sets the key inactive; you can turn it back on.")),
            h("tr", {}, h("td", {}, "OPENROUTER_MANAGEMENT_KEY"), h("td", {}, "OpenRouter, Settings, Management keys. Freezing disables the key; you can turn it back on.")),
            h("tr", {}, h("td", {}, "OPENAI_ADMIN_KEY"), h("td", {}, "OpenAI Platform, Settings, Admin keys. OpenAI can't disable a key, only delete it, so freezing needs keyward --allow-delete.")),
          ),
        ),
        h("pre", {}, "ANTHROPIC_ADMIN_KEY=… keyward\n\n# or in a terminal, freezing spikes automatically:\nANTHROPIC_ADMIN_KEY=… keyward watch --freeze"),
      ),
    );
    return;
  }
  const spend = s.spend;
  const refreshBtn = h(
    "button",
    {
      type: "button",
      class: "btn",
      disabled: ui.spendBusy,
      onclick: async () => {
        ui.spendBusy = true;
        renderSpend();
        try {
          s.spend = await api("/api/spend/refresh");
        } catch (err) {
          ui.spendMsg = err.message;
        }
        ui.spendBusy = false;
        render();
      },
    },
    ui.spendBusy ? "Checking…" : "Check now",
  );
  const spiking = spend ? spend.providers.flatMap((p) => p.keys.filter((k) => k.spike && k.active)) : [];
  root.replaceChildren(
    h(
      "section",
      { class: "verdict" },
      h("h1", {}, !spend ? "Checking spend…" : spiking.length ? `${spiking.length === 1 ? "One key is" : `${spiking.length} keys are`} spending far more than usual.` : "No key is spending more than usual."),
    ),
    h(
      "div",
      { class: "spend-top" },
      h("span", {}, spend ? `Checked at ${new Date(spend.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, and every 5 minutes while keyward runs.${ui.spendMsg ? ` ${ui.spendMsg}` : ""}` : ""),
      refreshBtn,
    ),
    ...(spend ? spend.providers.map((p) => providerBlock(p, spend)) : []),
  );
}

function providerBlock(p, spend) {
  const name = PROVIDER[p.provider];
  if (!p.ok) return h("section", { class: "provider" }, h("div", { class: "provider-head" }, h("h2", {}, name)), h("p", { class: "err" }, `Couldn't read usage: ${p.error}`));
  const spikes = p.keys.filter((k) => k.spike).length;
  const hourly = p.keys[0]?.unit !== "USD/day";
  return h(
    "section",
    { class: "provider" },
    h("div", { class: "provider-head" }, h("h2", {}, name), h("span", { class: "summary" }, `${plural(p.keys.length, "key")}${spikes ? `, ${spikes} spiking` : ""}`)),
    h("div", { class: "usage-head" }, h("span", {}, "Key"), h("span", {}, hourly ? "Last hour" : "Today"), h("span", {}, "Normal"), h("span", {}, hourly ? "Last 24 hours" : ""), h("span", {}, "")),
    p.keys.map((k) => usageRow(p.provider, k, spend)),
  );
}

function usageRow(provider, k, spend) {
  const tag = `${provider}:${k.id}`;
  const local = spend.local?.[tag] ?? [];
  const confirming = ui.confirmFreeze.has(tag);
  const verb = provider === "openai" ? "Delete" : "Freeze";
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
  let control = null;
  if (!k.canFreeze) control = provider === "openai" ? h("span", { class: "soft", title: "Start keyward with --allow-delete to allow deleting OpenAI keys" }, "Alerts only") : null;
  else if (k.active) control = h("button", { type: "button", class: `btn ${confirming ? "btn-confirm" : k.spike ? "btn-danger" : ""}`, onclick: () => freeze(true) }, confirming ? `Click again to ${verb.toLowerCase()}` : verb);
  else if (k.reversible) control = h("button", { type: "button", class: "btn", onclick: () => freeze(false) }, "Unfreeze");
  return h(
    "div",
    { class: `usage-row${k.spike && k.active ? " spike" : ""}` },
    h(
      "div",
      { class: "name" },
      h("strong", {}, k.name),
      k.active ? null : h("span", { class: "frozen" }, " (frozen)"),
      h("span", { class: "hint" }, k.hint),
      local.length
        ? h(
            "button",
            {
              type: "button",
              class: "local",
              onclick: () => {
                ui.tab = "keys";
                ui.reach.clear();
                ui.kind = null;
                ui.query = "";
                $("search").value = "";
                ui.open = new Set(local);
                render();
              },
            },
            `Found on this machine (${local.length})`,
          )
        : null,
    ),
    h("div", { class: `num${k.spike ? " hot" : ""}` }, amount(k.current, k.unit)),
    h("div", { class: "num soft" }, amount(k.baseline, k.unit)),
    h("div", {}, spark(k.series, k.spike)),
    h("div", { class: "act" }, control),
  );
}

// ---------- wiring ----------

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
  if (ui.state?.result) renderList(ui.state.result);
});
refresh();
