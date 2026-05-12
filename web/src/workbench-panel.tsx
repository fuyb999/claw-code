import { useEffect, useMemo, useState } from "react";

import { ArtifactCard } from "./artifacts";
import { AuditPanel } from "./audit-panel";
import { collectEvidenceEntries, summarizeEvidenceEntries } from "./evidence";
import {
  groupExpertArtifacts,
  hasExpertArtifactPresentation,
} from "./expert-artifacts";
import {
  collectExpertPanelEvents,
  collectExpertPanelExpertStatuses,
  collectExpertPanelSeeds,
  summarizeExpertPanels,
} from "./expert-panels";
import { EvidencePanel } from "./evidence-panel";
import { presentArtifactKind, presentDirectoryName } from "./presentation";
import { latestAssistantOutcomeSummary } from "./thread-outcomes";
import type { MemoryNote, ThreadSnapshot } from "./types";

export type WorkbenchTabId = "results" | "evidence" | "timeline" | "memory";
type WorkbenchTab = {
  id: WorkbenchTabId;
  label: string;
  count: number;
};

type WorkbenchPanelProps = {
  thread: ThreadSnapshot | null;
  operatorMode?: boolean;
  embeddedShell?: boolean;
  showHeader?: boolean;
  activeTab?: WorkbenchTabId;
  onTabChange?: (tab: WorkbenchTabId) => void;
  highlightedEvidenceId?: string | null;
  highlightedEvidenceAnchor?: string | null;
  highlightedArtifactId?: string | null;
  highlightedArtifactAnchor?: string | null;
  onOpenEvidence?: (evidenceId: string, anchor?: string | null) => void;
  onOpenArtifact?: (artifactId: string, anchor?: string | null) => void;
  onInsertReference?: (text: string) => void;
};

function formatTime(epochMs: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(epochMs);
}

function memoryScopeLabel(scope: MemoryNote["scope"]): string {
  if (scope === "workspace") {
    return "资料集共享";
  }

  if (scope === "tenant") {
    return "团队共享";
  }

  return "本会话";
}

function threadStatusLabel(status: ThreadSnapshot["status"]): string {
  switch (status) {
    case "running":
      return "运行中";
    case "interrupt_requested":
      return "停止中";
    case "failed":
      return "失败";
    case "idle":
    default:
      return "就绪";
  }
}

export function WorkbenchPanel({
  thread,
  operatorMode = false,
  embeddedShell = false,
  showHeader = true,
  activeTab: activeTabProp,
  onTabChange,
  highlightedEvidenceId = null,
  highlightedEvidenceAnchor = null,
  highlightedArtifactId = null,
  highlightedArtifactAnchor = null,
  onOpenEvidence,
  onOpenArtifact,
  onInsertReference,
}: WorkbenchPanelProps) {
  const evidenceEntries = useMemo(
    () => (thread ? collectEvidenceEntries(thread) : []),
    [thread],
  );
  const evidenceSummary = useMemo(
    () => summarizeEvidenceEntries(evidenceEntries),
    [evidenceEntries],
  );
  const latestOutcome = useMemo(() => latestAssistantOutcomeSummary(thread), [thread]);
  const expertArtifactGroup = useMemo(
    () => groupExpertArtifacts(thread?.artifacts ?? []),
    [thread?.artifacts],
  );
  const expertPanelEvents = useMemo(
    () => collectExpertPanelEvents(thread),
    [thread],
  );
  const expertPanelSeeds = useMemo(
    () => collectExpertPanelSeeds(thread),
    [thread],
  );
  const scopedExpertPanelSeed = useMemo(() => {
    if (!expertPanelSeeds.length) {
      return null;
    }
    if (!expertArtifactGroup.panelId) {
      return expertPanelSeeds[expertPanelSeeds.length - 1] ?? null;
    }
    const scoped = expertPanelSeeds.filter(
      (seed) => seed.panelId === expertArtifactGroup.panelId,
    );
    return scoped[scoped.length - 1] ?? expertPanelSeeds[expertPanelSeeds.length - 1] ?? null;
  }, [expertArtifactGroup.panelId, expertPanelSeeds]);
  const scopedExpertPanelEvents = useMemo(() => {
    const panelId = expertArtifactGroup.panelId ?? scopedExpertPanelSeed?.panelId ?? null;
    if (!panelId) {
      return expertPanelEvents;
    }
    const scoped = expertPanelEvents.filter(
      (event) => event.panelId === panelId,
    );
    return scoped.length ? scoped : expertPanelEvents;
  }, [expertArtifactGroup.panelId, expertPanelEvents, scopedExpertPanelSeed?.panelId]);
  const expertPanelSummary = useMemo(
    () => summarizeExpertPanels(scopedExpertPanelEvents, scopedExpertPanelSeed),
    [scopedExpertPanelEvents, scopedExpertPanelSeed],
  );
  const expertStatuses = useMemo(
    () =>
      collectExpertPanelExpertStatuses(
        scopedExpertPanelSeed,
        scopedExpertPanelEvents,
        thread?.artifacts ?? [],
      ),
    [scopedExpertPanelEvents, scopedExpertPanelSeed, thread?.artifacts],
  );
  const showExpertArtifactPresentation = useMemo(
    () => hasExpertArtifactPresentation(thread?.artifacts ?? []),
    [thread?.artifacts],
  );
  const tabs = useMemo(() => {
    const base: WorkbenchTab[] = [
      { id: "results" as const, label: "结果", count: thread?.artifacts.length ?? 0 },
      { id: "evidence" as const, label: "来源", count: evidenceEntries.length },
      { id: "timeline" as const, label: "过程", count: thread?.audit_records.length ?? 0 },
    ];

    if (operatorMode) {
      base.push({
        id: "memory" as const,
        label: "记忆",
        count: thread?.memory_notes.length ?? 0,
      });
    }

    return base;
  }, [evidenceEntries.length, operatorMode, thread?.artifacts.length, thread?.audit_records.length, thread?.memory_notes.length]);
  const [activeTab, setActiveTab] = useState<WorkbenchTabId>(activeTabProp ?? "results");
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const shellClassName = embeddedShell ? "workbench-card workbench-card-embedded" : "card workbench-card";

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) {
      setActiveTab(tabs[0]?.id ?? "results");
    }
  }, [activeTab, tabs]);

  useEffect(() => {
    if (activeTabProp && activeTabProp !== activeTab) {
      setActiveTab(activeTabProp);
    }
  }, [activeTab, activeTabProp]);

  useEffect(() => {
    if (!thread?.artifacts.length) {
      setSelectedArtifactId(null);
      return;
    }

    if (showExpertArtifactPresentation) {
      const preferredArtifactId =
        expertArtifactGroup.summaryArtifacts[0]?.id ??
        expertArtifactGroup.consensusArtifacts[0]?.id ??
        expertArtifactGroup.expertArtifacts[0]?.artifact.id ??
        expertArtifactGroup.otherArtifacts[0]?.id ??
        thread.artifacts[0]?.id ??
        null;
      if (
        preferredArtifactId &&
        (!selectedArtifactId ||
          !thread.artifacts.some((artifact) => artifact.id === selectedArtifactId))
      ) {
        setSelectedArtifactId(preferredArtifactId);
      }
      return;
    }

    if (!thread.artifacts.some((artifact) => artifact.id === selectedArtifactId)) {
      setSelectedArtifactId(thread.artifacts[0]!.id);
    }
  }, [
    expertArtifactGroup.consensusArtifacts,
    expertArtifactGroup.expertArtifacts,
    expertArtifactGroup.otherArtifacts,
    expertArtifactGroup.summaryArtifacts,
    selectedArtifactId,
    showExpertArtifactPresentation,
    thread?.artifacts,
  ]);

  useEffect(() => {
    if (highlightedArtifactId) {
      setSelectedArtifactId(highlightedArtifactId);
    }
  }, [highlightedArtifactId]);

  if (!thread) {
    return (
      <article className={shellClassName}>
        {showHeader ? (
          <div className="workbench-header">
            <div>
              <p className="eyebrow">Output</p>
              <h2>结果</h2>
              <p className="hero-copy">
                这里集中查看整理后的结论、引用来源和关键进展，聊天区只保留对话本身。
              </p>
            </div>
          </div>
        ) : null}
        <div className="empty-pane">
          选中会话后，这里会显示结果、来源与关键进展，不再全部堆到聊天消息里。
        </div>
      </article>
    );
  }

  const selectedArtifact =
    thread.artifacts.find((artifact) => artifact.id === selectedArtifactId) ??
    thread.artifacts[0] ??
    null;
  const selectedArtifactHighlight =
    selectedArtifact?.id === highlightedArtifactId ? highlightedArtifactAnchor : null;
  const featuredArtifact =
    expertArtifactGroup.summaryArtifacts[0] ??
    expertArtifactGroup.consensusArtifacts[0] ??
    expertArtifactGroup.stageArtifacts[0]?.artifact ??
    selectedArtifact;
  const featuredArtifactHighlight =
    featuredArtifact?.id === highlightedArtifactId ? highlightedArtifactAnchor : null;

  return (
    <article className={shellClassName}>
      {showHeader ? (
        <div className="workbench-header">
          <div>
            <p className="eyebrow">Output</p>
            <h2>结果</h2>
            <p className="hero-copy">
              以交付内容为中心查看结论、来源和关键进展，主聊天区保持简洁。
            </p>
          </div>
          <div className="workbench-meta">
            <span className={`status-pill status-${thread.status}`}>
              {threadStatusLabel(thread.status)}
            </span>
            <span>{presentDirectoryName(thread.workspace_root) === "纯聊天" ? "模式 纯聊天" : `资料库 ${presentDirectoryName(thread.workspace_root)}`}</span>
            <span>更新于 {formatTime(thread.updated_at_ms)}</span>
          </div>
        </div>
      ) : null}

      <div className="workbench-tabs" role="tablist" aria-label="结果面板标签">
        {tabs.map((tab) => (
          <button
            aria-selected={activeTab === tab.id}
            className={`workbench-tab ${activeTab === tab.id ? "active" : ""}`}
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              onTabChange?.(tab.id);
            }}
            role="tab"
            type="button"
          >
            <span>{tab.label}</span>
            <strong>{tab.count}</strong>
          </button>
        ))}
      </div>

      <div className="workbench-body">
        {latestOutcome ? (
          <section className="workbench-summary-card">
            <div className="workbench-summary-copy">
              <span className="workbench-summary-eyebrow">本轮进展</span>
              <strong>
                {latestOutcome.summary.runningStepCount
                  ? "仍在补充结果与引用"
                  : latestOutcome.summary.artifactCount
                    ? `已沉淀 ${latestOutcome.summary.artifactCount} 份结果`
                    : latestOutcome.summary.evidenceCount
                      ? `已沉淀 ${latestOutcome.summary.evidenceCount} 条来源`
                      : `完成了 ${latestOutcome.summary.stepCount} 个动作`}
              </strong>
            </div>
            <div className="workbench-summary-metrics">
              {latestOutcome.summary.artifactCount ? (
                <span>结果 {latestOutcome.summary.artifactCount}</span>
              ) : null}
              {latestOutcome.summary.evidenceCount ? (
                <span>来源 {latestOutcome.summary.evidenceCount}</span>
              ) : null}
              {latestOutcome.summary.stepCount ? (
                <span>动作 {latestOutcome.summary.stepCount}</span>
              ) : null}
              {latestOutcome.summary.failedStepCount ? (
                <span>失败 {latestOutcome.summary.failedStepCount}</span>
              ) : null}
            </div>
          </section>
        ) : null}

        {expertPanelSummary ? (
          <section className="workbench-summary-card expert-panel-summary-card">
            <div className="workbench-summary-copy">
              <span className="workbench-summary-eyebrow">专家会诊</span>
              <strong>
                {expertPanelSummary.finalSummaryReady
                  ? "综合结论已整理完成"
                  : expertPanelSummary.completedExperts.length
                    ? `已完成 ${expertPanelSummary.completedExperts.length} 位专家视角`
                    : "专家会诊已开始"}
              </strong>
            </div>
            <div className="workbench-summary-metrics">
              <span>记录 {expertPanelSummary.totalEvents}</span>
              {expertPanelSummary.plannedExperts.length ? (
                <span>已选专家 {expertPanelSummary.plannedExperts.length}</span>
              ) : null}
              {expertPanelSummary.completedExperts.length ? (
                <span>专家 {expertPanelSummary.completedExperts.length}</span>
              ) : null}
              {expertPanelSummary.latestStageLabel ? (
                <span>阶段 {expertPanelSummary.latestStageLabel}</span>
              ) : null}
            </div>
            {expertPanelSummary.latestSummary ? (
              <p className="workbench-summary-note">{expertPanelSummary.latestSummary}</p>
            ) : null}
            {expertPanelSummary.pendingExperts.length ? (
              <p className="workbench-summary-note">
                待完成：{expertPanelSummary.pendingExperts.join("、")}
              </p>
            ) : null}
            {expertPanelSummary.completedExperts.length ? (
              <div className="expert-panel-summary-chips">
                {expertPanelSummary.completedExperts.map((name) => (
                  <span key={name}>{name}</span>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {activeTab === "results" ? (
          thread.artifacts.length ? (
            <div className="results-workspace">
              {showExpertArtifactPresentation ? (
                <div className="result-list result-list-expert">
                  <section className="result-group expert-stage-group">
                    <div className="result-group-header">
                      <strong>会诊阶段</strong>
                      <span>
                        {expertPanelSummary?.latestStageLabel ?? "等待推进"}
                      </span>
                    </div>
                    <div className="expert-stage-strip">
                      {[
                        { id: "phase_0", label: "议题" },
                        { id: "phase_1", label: "评估" },
                        { id: "phase_2", label: "辩论" },
                        { id: "phase_3", label: "共识" },
                        { id: "phase_4", label: "结论" },
                      ].map((stage) => {
                        const active = expertPanelSummary?.latestStage === stage.id;
                        const complete = expertArtifactGroup.stageArtifacts.some(
                          (entry) => entry.stage === stage.id,
                        );
                        return (
                          <button
                            className={`expert-stage-pill ${
                              active ? "active" : complete ? "complete" : ""
                            }`}
                            key={stage.id}
                            onClick={() => {
                              const artifact = expertArtifactGroup.stageArtifacts.find(
                                (entry) => entry.stage === stage.id,
                              )?.artifact;
                              if (artifact) {
                                setSelectedArtifactId(artifact.id);
                              }
                            }}
                            type="button"
                          >
                            {stage.label}
                          </button>
                        );
                      })}
                    </div>
                  </section>

                  {featuredArtifact ? (
                    <section className="result-group expert-featured-group">
                      <div className="result-group-header">
                        <strong>本轮主结果</strong>
                        <span>{presentArtifactKind(featuredArtifact.kind)}</span>
                      </div>
                      <div className="expert-featured-preview">
                        <ArtifactCard
                          artifact={featuredArtifact}
                          highlightedAnchor={featuredArtifactHighlight}
                          onOpenArtifact={onOpenArtifact}
                          onOpenEvidence={onOpenEvidence}
                          onInsertReference={onInsertReference}
                        />
                      </div>
                    </section>
                  ) : null}

                  {expertStatuses.length ? (
                    <section className="result-group expert-status-group">
                      <div className="result-group-header">
                        <strong>专家执行</strong>
                        <span>{expertStatuses.length}</span>
                      </div>
                      <div className="expert-status-list">
                        {expertStatuses.map((expert) => (
                          <button
                            className={`expert-status-card ${
                              expert.artifactId && featuredArtifact?.id === expert.artifactId
                                ? "active"
                                : ""
                            }`}
                            key={expert.expertName}
                            onClick={() => {
                              if (expert.artifactId) {
                                setSelectedArtifactId(expert.artifactId);
                              }
                            }}
                            type="button"
                          >
                            <div className="expert-status-card-head">
                              <strong>{expert.expertName}</strong>
                              <span
                                className={`expert-status-pill expert-status-${expert.status}`}
                              >
                                {expert.completed
                                  ? "已完成"
                                  : expert.status === "running"
                                    ? "进行中"
                                    : "待开始"}
                              </span>
                            </div>
                            <span className="expert-status-stage">
                              {expert.stageLabel ?? "等待独立评估"}
                            </span>
                            {expert.summary ? (
                              <p className="expert-status-summary">{expert.summary}</p>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {expertArtifactGroup.summaryArtifacts.length ? (
                    <section className="result-group">
                      <div className="result-group-header">
                        <strong>最终结论</strong>
                        <span>{expertArtifactGroup.summaryArtifacts.length}</span>
                      </div>
                      <div className="result-group-list">
                        {expertArtifactGroup.summaryArtifacts.map((artifact) => (
                          <button
                            className={`result-item ${
                              selectedArtifact?.id === artifact.id ? "active" : ""
                            }`}
                            key={artifact.id}
                            onClick={() => setSelectedArtifactId(artifact.id)}
                            type="button"
                          >
                            <div className="result-item-header">
                              <strong>{artifact.title ?? "未命名结果"}</strong>
                              <span>{presentArtifactKind(artifact.kind)}</span>
                            </div>
                            <span className="result-item-meta">
                              创建于 {formatTime(artifact.created_at_ms)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {expertArtifactGroup.consensusArtifacts.length ? (
                    <section className="result-group">
                      <div className="result-group-header">
                        <strong>共识与分歧</strong>
                        <span>{expertArtifactGroup.consensusArtifacts.length}</span>
                      </div>
                      <div className="result-group-list">
                        {expertArtifactGroup.consensusArtifacts.map((artifact) => (
                          <button
                            className={`result-item ${
                              selectedArtifact?.id === artifact.id ? "active" : ""
                            }`}
                            key={artifact.id}
                            onClick={() => setSelectedArtifactId(artifact.id)}
                            type="button"
                          >
                            <div className="result-item-header">
                              <strong>{artifact.title ?? "未命名结果"}</strong>
                              <span>{presentArtifactKind(artifact.kind)}</span>
                            </div>
                            <span className="result-item-meta">
                              创建于 {formatTime(artifact.created_at_ms)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {expertArtifactGroup.stageArtifacts.length ? (
                    <section className="result-group">
                      <div className="result-group-header">
                        <strong>阶段产出</strong>
                        <span>{expertArtifactGroup.stageArtifacts.length}</span>
                      </div>
                      <div className="result-group-list">
                        {expertArtifactGroup.stageArtifacts.map(({ stage, stageLabel, artifact }) => (
                          <button
                            className={`result-item ${
                              selectedArtifact?.id === artifact.id ? "active" : ""
                            }`}
                            key={artifact.id}
                            onClick={() => setSelectedArtifactId(artifact.id)}
                            type="button"
                          >
                            <div className="result-item-header">
                              <strong>{stageLabel ?? stage}</strong>
                              <span>{presentArtifactKind(artifact.kind)}</span>
                            </div>
                            <span className="result-item-meta">
                              {artifact.title ?? "未命名结果"}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {expertArtifactGroup.expertArtifacts.length ? (
                    <section className="result-group">
                      <div className="result-group-header">
                        <strong>专家单卡</strong>
                        <span>{expertArtifactGroup.expertArtifacts.length}</span>
                      </div>
                      <div className="result-group-list">
                        {expertArtifactGroup.expertArtifacts.map(({ expertName, artifact }) => (
                          <button
                            className={`result-item result-item-expert ${
                              selectedArtifact?.id === artifact.id ? "active" : ""
                            }`}
                            key={artifact.id}
                            onClick={() => setSelectedArtifactId(artifact.id)}
                            type="button"
                          >
                            <div className="result-item-header">
                              <strong>{expertName}</strong>
                              <span>{presentArtifactKind(artifact.kind)}</span>
                            </div>
                            <span className="result-item-meta">
                              {artifact.title ?? "未命名结果"}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {expertArtifactGroup.otherArtifacts.length ? (
                    <section className="result-group">
                      <div className="result-group-header">
                        <strong>其他结果</strong>
                        <span>{expertArtifactGroup.otherArtifacts.length}</span>
                      </div>
                      <div className="result-group-list">
                        {expertArtifactGroup.otherArtifacts.map((artifact) => (
                          <button
                            className={`result-item ${
                              selectedArtifact?.id === artifact.id ? "active" : ""
                            }`}
                            key={artifact.id}
                            onClick={() => setSelectedArtifactId(artifact.id)}
                            type="button"
                          >
                            <div className="result-item-header">
                              <strong>{artifact.title ?? "未命名结果"}</strong>
                              <span>{presentArtifactKind(artifact.kind)}</span>
                            </div>
                            <span className="result-item-meta">
                              创建于 {formatTime(artifact.created_at_ms)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </div>
              ) : thread.artifacts.length > 1 ? (
                <div className="result-list">
                  {thread.artifacts.map((artifact) => (
                    <button
                      className={`result-item ${
                        selectedArtifact?.id === artifact.id ? "active" : ""
                      }`}
                      key={artifact.id}
                      onClick={() => setSelectedArtifactId(artifact.id)}
                      type="button"
                    >
                      <div className="result-item-header">
                        <strong>{artifact.title ?? "未命名结果"}</strong>
                        <span>{presentArtifactKind(artifact.kind)}</span>
                      </div>
                      <span className="result-item-meta">
                        创建于 {formatTime(artifact.created_at_ms)}
                      </span>
                      {highlightedArtifactId === artifact.id ? (
                        <span className="result-item-link-state">
                          已从对话定位
                          {highlightedArtifactAnchor ? ` · ${highlightedArtifactAnchor}` : ""}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="result-preview">
                {showExpertArtifactPresentation ? (
                  <section className="expert-result-summary">
                    {expertArtifactGroup.summaryArtifacts.length ? (
                      <span>综合结论 {expertArtifactGroup.summaryArtifacts.length}</span>
                    ) : null}
                    {expertArtifactGroup.consensusArtifacts.length ? (
                      <span>共识分歧 {expertArtifactGroup.consensusArtifacts.length}</span>
                    ) : null}
                    {expertArtifactGroup.stageArtifacts.length ? (
                      <span>阶段产出 {expertArtifactGroup.stageArtifacts.length}</span>
                    ) : null}
                    {expertArtifactGroup.expertArtifacts.length ? (
                      <span>专家单卡 {expertArtifactGroup.expertArtifacts.length}</span>
                    ) : null}
                  </section>
                ) : null}
                {!showExpertArtifactPresentation && selectedArtifact ? (
                  <ArtifactCard
                    artifact={selectedArtifact}
                    highlightedAnchor={selectedArtifactHighlight}
                    onOpenArtifact={onOpenArtifact}
                    onOpenEvidence={onOpenEvidence}
                    onInsertReference={onInsertReference}
                  />
                ) : null}
              </div>
            </div>
          ) : (
            <section className="workbench-empty-card">
              <div className="workbench-empty-copy">
                <strong>这轮还没有结构化结果</strong>
                <p>
                  当前还没有 Markdown、表格、图表或关系图结果。
                  {evidenceEntries.length
                    ? " 但已经出现检索来源，可以先查看来源内容。"
                    : " 等 agent 完成整理后，结果会沉淀在这里。"}
                </p>
              </div>
              {evidenceEntries.length ? (
                <div className="workbench-empty-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setActiveTab("evidence");
                      onTabChange?.("evidence");
                    }}
                    type="button"
                  >
                    查看来源
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      setActiveTab("timeline");
                      onTabChange?.("timeline");
                    }}
                    type="button"
                  >
                    查看进展
                  </button>
                </div>
              ) : null}
            </section>
          )
        ) : null}

        {activeTab === "evidence" ? (
          <>
            {evidenceEntries.length ? (
              <section className="workbench-evidence-summary">
                <div className="workbench-summary-copy">
                  <span className="workbench-summary-eyebrow">来源概览</span>
                  <strong>
                    已整理 {evidenceSummary.totalQueries} 次检索，
                    命中预览 {evidenceSummary.totalHitsPreview} 条来源
                  </strong>
                </div>
                <div className="workbench-summary-metrics">
                  <span>成功 {evidenceSummary.successCount}</span>
                  {evidenceSummary.errorCount ? (
                    <span>失败 {evidenceSummary.errorCount}</span>
                  ) : null}
                </div>
              </section>
            ) : null}
            <EvidencePanel
              embedded
              highlightedAnchor={highlightedEvidenceAnchor}
              highlightedEntryId={highlightedEvidenceId}
              onInsertReference={onInsertReference}
              operatorMode={operatorMode}
              thread={thread}
            />
          </>
        ) : null}

        {activeTab === "timeline" ? (
          <AuditPanel
            embedded
            operatorMode={operatorMode}
            thread={thread}
            title={operatorMode ? "运行记录" : "关键进展"}
          />
        ) : null}

        {activeTab === "memory" && operatorMode ? (
          <>
            <div className="section-title">可见记忆</div>
            {thread.memory_notes.length ? (
              <div className="memory-list">
                {thread.memory_notes.map((note) => (
                  <article className="memory-item" key={note.id}>
                    <header>
                      <strong>{formatTime(note.created_at_ms)}</strong>
                      <span className={`scope-pill scope-${note.scope}`}>
                        {memoryScopeLabel(note.scope)}
                      </span>
                    </header>
                    <p>{note.note}</p>
                    {note.tags.length ? (
                      <div className="tags">
                        {note.tags.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                运行过程中沉淀的记忆会显示在这里。
              </div>
            )}
          </>
        ) : null}
      </div>
    </article>
  );
}
