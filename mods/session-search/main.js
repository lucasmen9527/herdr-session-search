// 会话历史：按关键词全文搜索所有 agent 的历史会话（Claude / Codex / OMP / Pi / Gemini / OpenCode），
// 回车或点击：会话已经在某个终端里跑着就跳过去，否则在对应项目的 space 里新开 tab 恢复。
// 索引由 indexer/cli.mjs 维护（~/.config/herdr-app/data/session-search/index.sqlite），每次打开增量更新。
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { exec, appHome, home, theme, props, closeOverlay, run, spaces, panes, terminals, focused, notify, readTextFile } from "herdr";
import { agentLabel, buildLaunch, findLiveTerminal, pickSpace, relativeTime, shortPath } from "./logic.js";

const SEARCH_DEBOUNCE_MS = 120;
const LIST_MAX_HEIGHT = 520;
const ROW_HEIGHT = 68;

export default class SessionSearch extends View {
  init(_props, cx) {
    this.query = "";
    this.scope = "all"; // "all" | "here"
    this.results = [];
    this.at = 0;
    this.seq = 0;
    this.status = null;
    this.indexing = false;
    this.error = null;
    this.node = "node";
    this.cli = `${appHome()}/mods/session-search/indexer/cli.mjs`;
    this.here = focused()?.cwd ?? null;
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "搜索会话：标题、你的提问、AI 的回复…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.schedule(cx);
    });
    this.input.on("submit", (_e, cx) => this.go(this.results[this.at], cx));
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    cx.spawn(async (cx) => {
      try {
        const cfg = JSON.parse((await readTextFile(`${appHome()}/mods/session-search/config.json`)) ?? "{}");
        if (cfg.node) this.node = cfg.node;
      } catch {}
      await this.search(cx);
      await this.reindex(cx);
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  async cliJson(args, timeout) {
    const r = await exec(this.node, ["--no-warnings", this.cli, ...args], { timeout });
    const out = JSON.parse(r.stdout || "{}");
    if (out.error) throw new Error(out.error);
    return out;
  }

  schedule(cx) {
    const mine = ++this.seq;
    cx.timer.after(SEARCH_DEBOUNCE_MS, (cx) => {
      if (mine === this.seq) cx.spawn(async (cx) => this.search(cx));
    });
  }

  async search(cx) {
    const mine = this.seq;
    // 用 --q=值：搜索词以 - 开头时不会被当成选项
    const args = ["search", `--q=${this.query}`, "--limit=80"];
    if (this.scope === "here" && this.here) args.push(`--scope=${this.here}`);
    try {
      const out = await this.cliJson(args, 15000);
      if (mine !== this.seq) return; // 已经有更新的输入
      this.results = out.sessions ?? [];
      this.status = out.status ?? this.status;
      this.error = null;
      this.at = 0;
      this.generation = (this.generation ?? 0) + 1; // 换列表 id：新结果从顶部开始，不调 scroll_to_item(0)
    } catch (e) {
      this.error = String(e?.message ?? e);
    }
    cx.notify();
  }

  async reindex(cx) {
    this.indexing = true;
    cx.notify();
    try {
      const out = await this.cliJson(["index"], 600000);
      if (!out.busy) this.status = out;
    } catch (e) {
      this.error = `索引失败：${e?.message ?? e}`;
    }
    this.indexing = false;
    await this.search(cx);
  }

  setScope(scope, cx) {
    if (scope === "here" && !this.here) return;
    this.scope = scope;
    this.seq++;
    cx.spawn(async (cx) => this.search(cx));
    this.input.focus();
  }

  go(s, cx) {
    if (!s) return;
    const live = findLiveTerminal(terminals(), s);
    if (live) {
      this.close();
      run("pane.focus", { terminal: live.address });
      return;
    }
    cx.spawn(async () => {
      let exists = false;
      try {
        exists = Boolean(s.cwd) && (await exec("test", ["-d", s.cwd], { timeout: 5000 })).code === 0;
      } catch {}
      this.close();
      const launch = buildLaunch(s, home(), () => exists);
      const space = pickSpace(spaces(), panes(), launch.folder);
      if (space) run("tab.new", { space: space.id, folder: launch.folder, argv: launch.argv, name: launch.name });
      else run("space.new", { folder: launch.folder, argv: launch.argv, tab: launch.name });
      if (launch.warning) notify({ title: "会话目录不在了", body: launch.warning, level: "warning", timeout: 6000 });
    });
  }

  statusLine(t) {
    if (this.error) return div().text_color(t.blocked).truncate().child(this.error);
    const st = this.status;
    const left = this.indexing ? "正在更新索引…" : st ? `已索引 ${st.sessions} 个会话` : "首次建索引中…";
    const right = st?.at ? `更新于${relativeTime(st.at)}` : "";
    return h_flex().gap(8).items_center().text_color(t.dim)
      .child(this.indexing ? div().text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90) : div().child("✓"))
      .child(div().flex_1().child(left))
      .child(div().child(right));
  }

  pill(t, id, label, active, enabled, onClick) {
    return div().id(id).px(12).py(4).rounded(7).text_size(12)
      .when(active, (el) => el.bg(t.selected).text_color(t.foreground).font_semibold())
      .when(!active, (el) => el.text_color(enabled ? t.muted : t.dim))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  row(t, s, i, live) {
    const on = i === this.at;
    const a = agentLabel(s.agent);
    const meta = [`${s.msgCount} 条消息`, relativeTime(s.updatedAt), shortPath(s.cwd, home()), s.model].filter(Boolean).join(" · ");
    return v_flex().id(`ss-${s.agent}-${s.sessionId}`).h(ROW_HEIGHT).flex_none().justify_center().mx(4).px(12).gap(3).rounded(8).cursor_pointer()
      .when(on, (el) => el.bg(t.hover))
      .hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => this.go(s, cx))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(s.title))
        .when(Boolean(live), (el) => el.child(div().px(6).rounded(4).text_size(10.5).bg(t.working).text_color(t.background).child("运行中"))))
      .child(div().truncate().text_size(12).text_color(t.muted).child(s.preview || " "))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().px(5).rounded(4).border_1().border_color(a.color).text_color(a.color).child(a.name))
        .when(s.hits > 0, (el) => el.child(div().text_color(t.accent).child(`${s.hits} 处命中`)))
        .child(div().flex_1().min_w(0).truncate().child(meta)));
  }

  render() {
    const t = theme();
    const live = terminals();
    const list = this.results;
    if (this.at >= list.length) this.at = Math.max(0, list.length - 1);
    const hereName = this.here ? shortPath(this.here, home()) : "当前目录";
    return v_flex().id("session-search").track_focus(this.handle).w_full().min_h(0).p(16).gap(10)
      .bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down" && list.length) this.at = (this.at + 1) % list.length;
        else if (k === "up" && list.length) this.at = (this.at + list.length - 1) % list.length;
        else if (k === "tab") this.setScope(this.scope === "all" ? "here" : "all", cx);
        else return;
        if (k !== "tab") this.scroll.scroll_to_item(this.at);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(10)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("会话历史"))
        .child(h_flex().gap(2).p(2).rounded(9).bg(t.surface)
          .child(this.pill(t, "ss-scope-all", "全部", this.scope === "all", true, (cx) => this.setScope("all", cx)))
          .child(this.pill(t, "ss-scope-here", hereName, this.scope === "here", Boolean(this.here), (cx) => this.setScope("here", cx))))
        .child(div().flex_1())
        .child(div().id("ss-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(div().text_size(11.5).child(this.statusLine(t)))
      .child(list.length
        // 弹窗高度随内容，滚动区必须给明确高度，否则会被压成 0
        ? v_flex().id(`ss-list-${this.generation ?? 0}`).h(Math.min(LIST_MAX_HEIGHT, list.length * (ROW_HEIGHT + 2))).flex_none().overflow_y_scrollbar().track_scroll(this.scroll).gap(2)
          .children(list.map((s, i) => this.row(t, s, i, findLiveTerminal(live, s))))
        : div().py(24).text_color(t.dim).text_size(12.5).flex().justify_center()
          .child(this.query ? "没有匹配的会话" : this.status ? "还没有会话" : "正在建索引，第一次大约需要半分钟…"))
      .child(div().text_size(11).text_color(t.dim).child("↑↓ 选择 · 回车打开（在跑就跳转，否则新开 tab 恢复）· Tab 切换范围 · 多个词用空格分隔"));
  }
}
