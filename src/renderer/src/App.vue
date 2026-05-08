<template>
  <div class="app">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="logo">
          <span class="logo-icon">◈</span>
          <span class="logo-text">Bliss Agent</span>
        </div>
      </div>

      <!-- Working Directory -->
      <div class="sidebar-section">
        <label class="section-label">WORKING DIR</label>
        <div class="dir-picker" @click="pickFolder">
          <span class="dir-icon">⬡</span>
          <span class="dir-path">{{ workingDir || 'Select folder...' }}</span>
        </div>
      </div>

      <!-- Model info -->
      <div class="sidebar-section model-card">
        <div class="model-badge">
          <span class="model-dot"></span>
          <span>{{ activeModelLabel }}</span>
        </div>
        <div class="model-meta">{{ activeModelMeta }}</div>
        <div v-if="activeFallbackSummary" class="model-runtime" :class="activeFallbackTone">{{ activeFallbackSummary }}</div>
      </div>

      <div class="sidebar-section github-card">
        <label class="section-label">GITHUB</label>
        <div class="github-status-card" :class="[githubStatusTone, { clickable: githubStatusLoginAvailable }]" @click="handleGitHubStatusClick">
          <div class="github-status-head">
            <span class="github-status-dot"></span>
            <span>{{ githubStatusLabel }}</span>
          </div>
          <div class="github-status-body">{{ githubStatusDetail }}</div>
        </div>
      </div>

      <div class="sidebar-section chats-section">
        <div class="chats-section-head">
          <label class="section-label">CHATS</label>
          <span class="chats-count">{{ chatSessions.length }}</span>
        </div>
        <div class="chats-list">
          <div
            v-for="chat in chatSessions"
            :key="chat.id"
            class="chat-session-item"
            :class="{ active: chat.id === activeChatId, editing: chat.id === editingChatId }"
          >
            <template v-if="chat.id === editingChatId">
              <div class="chat-session-edit" @click.stop>
                <input
                  ref="chatRenameInputEl"
                  v-model="editingChatTitle"
                  class="chat-session-rename-input"
                  type="text"
                  maxlength="80"
                  @keydown.enter.prevent="commitChatRename(chat.id)"
                  @keydown.esc.prevent="cancelChatRename"
                />
                <div class="chat-session-edit-actions">
                  <button class="chat-session-action" @click="commitChatRename(chat.id)">Save</button>
                  <button class="chat-session-action danger" @click="cancelChatRename">Cancel</button>
                </div>
              </div>
            </template>
            <template v-else>
              <button
                class="chat-session-main"
                :disabled="isRunning && chat.id !== activeChatId"
                @click="selectChat(chat.id)"
              >
                <span class="chat-session-title">{{ chat.title }}</span>
                <span class="chat-session-meta">{{ getChatSessionMeta(chat) }}</span>
              </button>
              <div class="chat-session-actions">
                <button
                  class="chat-session-action"
                  :disabled="isRunning"
                  @click.stop="startChatRename(chat)"
                >Rename</button>
                <button
                  class="chat-session-action danger"
                  :disabled="isRunning"
                  @click.stop="deleteChat(chat.id)"
                >Delete</button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div class="sidebar-footer">
        <button class="new-chat-btn" :disabled="isRunning" @click="newChat">
          <span>+</span> New chat
        </button>
      </div>
    </aside>

    <!-- Main -->
    <main class="main">
      <!-- Header -->
      <div class="topbar">
        <div class="topbar-title">
          {{ workingDir ? workingDir.split('/').pop() || workingDir.split('\\').pop() : 'No project selected' }}
        </div>
        <div class="topbar-actions">
          <button v-if="apiKeyMissing" class="topbar-alert" @click="openSettings('provider')">
            <span class="topbar-alert-dot"></span>
            <span>{{ activeProvider.inputLabel }} missing</span>
          </button>
          <div class="provider-pill">
            <span class="provider-pill-label">{{ activeProvider.label }}</span>
            <span class="provider-pill-value">{{ activeModelLabel }}</span>
          </div>
          <button class="settings-btn" @click="openSettings()">
            <span class="settings-btn-icon">⌘</span>
            <span>Settings</span>
          </button>
          <div class="topbar-status" :class="{ active: isRunning }">
            <span class="status-dot"></span>
            {{ isRunning ? 'Running' : 'Ready' }}
          </div>
        </div>
      </div>

      <div v-if="hasActiveApprovalPolicy" class="approval-policy-banner">
        <div class="approval-policy-copy">
          <span class="approval-policy-label">AUTO-APPROVAL ACTIVE</span>
          <span class="approval-policy-text">{{ activeApprovalPolicySummary }}</span>
        </div>
        <button class="approval-policy-clear" @click="clearApprovalPolicy()">
          Turn off
        </button>
      </div>

      <div class="workspace">
        <section class="chat-pane">
          <div class="messages" ref="messagesEl">
            <div v-if="displayMessages.length === 0" class="empty-state">
              <div class="empty-icon">◈</div>
              <h2 class="empty-title">Bliss Agent</h2>
              <p>{{ emptyStateDescription }}<br>Select a working directory and start coding.</p>
              <div class="suggestions">
                <button
                  v-for="s in suggestions"
                  :key="s"
                  class="suggestion-btn"
                  @click="useSuggestion(s)"
                >{{ s }}</button>
              </div>
            </div>

            <template v-else>
              <div
                v-for="(msg, i) in displayMessages"
                :key="i"
                class="message"
                :class="msg.type"
              >
                <template v-if="msg.type === 'user'">
                  <div class="msg-avatar user-avatar">U</div>
                  <div class="msg-body">
                    <div class="msg-text">{{ msg.content }}</div>
                  </div>
                </template>

                <template v-else-if="msg.type === 'assistant'">
                  <div class="msg-avatar agent-avatar">◈</div>
                  <div class="msg-body">
                    <div class="msg-text" :class="{ streaming: msg.isStreaming }" v-html="renderMarkdown(msg.content)" @click="handleAssistantContentClick($event, msg)"></div>
                  </div>
                </template>

                <template v-else-if="msg.type === 'approval'">
                  <div class="msg-avatar agent-avatar">!</div>
                  <div class="msg-body">
                    <div class="approval-card" :class="[`risk-${msg.riskLevel || 'medium'}`, { resolved: msg.resolved }]">
                      <div class="approval-head">
                        <span class="approval-title">{{ msg.title || 'Approval required' }}</span>
                        <span class="approval-risk">{{ (msg.riskLevel || 'medium').toUpperCase() }}</span>
                      </div>
                      <div class="approval-summary">{{ msg.summary }}</div>
                      <div v-if="formatToolArgs(msg.args)" class="approval-args">{{ formatToolArgs(msg.args) }}</div>
                      <div v-if="!msg.resolved" class="approval-actions">
                        <button class="composer-btn composer-btn-primary" :disabled="msg.submitting" @click="respondToApproval(msg, true)">
                          {{ msg.submitting ? 'Sending...' : 'Approve' }}
                        </button>
                        <button class="composer-btn composer-btn-secondary" :disabled="msg.submitting" @click="respondToApproval(msg, true, { scope: 'tool', decision: 'approved-all-tool' })">
                          Approve all {{ getApprovalScopeLabel(msg, 'tool') }} in chat
                        </button>
                        <button class="composer-btn composer-btn-secondary" :disabled="msg.submitting" @click="respondToApproval(msg, true, { scope: 'chat', decision: 'approved-all-chat' })">
                          Approve all in chat
                        </button>
                        <button class="composer-btn composer-btn-secondary" :disabled="msg.submitting" @click="respondToApproval(msg, false)">
                          Deny
                        </button>
                      </div>
                      <div v-else class="approval-status">
                        {{ getApprovalStatusLabel(msg.decision) }}
                      </div>
                    </div>
                  </div>
                </template>

                <template v-else-if="msg.type === 'tool'">
                  <div class="tool-call">
                    <div class="tool-call-header" :class="{ expandable: canExpandToolResult(msg), expanded: isToolResultExpanded(msg) }" @click="toggleToolResultExpansion(msg)">
                      <span class="tool-call-icon">{{ getToolIcon(msg.tool) }}</span>
                      <span class="tool-call-name">{{ msg.tool }}</span>
                      <span class="tool-call-args">{{ formatToolArgs(msg.args) }}</span>
                      <div v-if="toolResultItems(msg).length" class="tool-call-meta">
                        <span class="tool-call-count">{{ getToolResultCountLabel(msg) }}</span>
                        <span v-if="canExpandToolResult(msg)" class="tool-call-chevron">{{ isToolResultExpanded(msg) ? '−' : '+' }}</span>
                      </div>
                    </div>
                    <div v-if="!msg.result && msg.progress?.message" class="tool-call-progress">{{ msg.progress.message }}</div>
                    <div v-if="msg.result" class="tool-call-result" :class="{ error: !msg.result.success, expanded: isToolResultExpanded(msg) }">
                      <template v-if="visibleToolResultItems(msg).length">
                        <component
                          v-for="item in visibleToolResultItems(msg)"
                          :key="`${msg.tool}-${item.path}-${item.lineNumber || 0}`"
                          :is="item.previewable === false ? 'div' : 'button'"
                          class="tool-result-item"
                          :class="{ clickable: item.previewable !== false }"
                          @click="handleToolResultItemClick(item)"
                        >
                          <span class="tool-result-item-main">
                            <span class="tool-result-item-icon">{{ getToolResultItemIcon(item) }}</span>
                            <span class="tool-result-item-path">{{ getToolResultItemLabel(item) }}</span>
                          </span>
                          <span v-if="item.lineNumber" class="tool-result-item-line">L{{ item.lineNumber }}</span>
                          <span v-if="item.line" class="tool-result-item-text">{{ item.line }}</span>
                        </component>
                      </template>
                      <template v-else>
                        {{ formatToolResult(msg.result) }}
                      </template>
                    </div>

                    <div
                      v-if="shouldShowWorkflowInline(msg, i)"
                      class="workflow-inline"
                      :class="{ expanded: isWorkflowExpanded(msg.turnId) }"
                    >
                      <button class="workflow-inline-toggle" @click="toggleWorkflow(msg.turnId)">
                        <div class="workflow-inline-head">
                          <span class="workflow-inline-title">Workflow</span>
                          <span class="workflow-inline-summary">{{ getWorkflowSummaryLine(msg.turnId) }}</span>
                        </div>
                        <div class="workflow-inline-meta">
                          <span v-if="getWorkflowIterationLabel(msg.turnId)" class="workflow-inline-iteration">{{ getWorkflowIterationLabel(msg.turnId) }}</span>
                          <span class="workflow-inline-state">{{ getWorkflowStateLabel(msg.turnId) }}</span>
                          <span class="workflow-inline-chevron">{{ isWorkflowExpanded(msg.turnId) ? '−' : '+' }}</span>
                        </div>
                      </button>

                      <div v-if="isWorkflowExpanded(msg.turnId)" class="workflow-inline-body">
                        <div class="workflow-lines">
                          <div
                            v-for="entry in getWorkflowLines(msg.turnId)"
                            :key="entry.id"
                            class="workflow-line"
                            :class="entry.tone"
                          >
                            <span class="workflow-line-label">{{ entry.label }}</span>
                            <span class="workflow-line-text">{{ entry.text }}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </template>

                <template v-else-if="msg.type === 'thinking'">
                  <div class="thinking">
                    <span class="thinking-dot"></span>
                    <span class="thinking-dot"></span>
                    <span class="thinking-dot"></span>
                    <span class="thinking-label">{{ msg.text || 'Thinking...' }}</span>
                  </div>
                </template>
              </div>
            </template>
          </div>

          <div class="input-area">
            <div v-if="queuedDraftCount" class="queued-draft">
              <div class="queued-draft-header">
                <div class="queued-draft-copy">
                  <span class="queued-draft-label">{{ queuedDraftLabel }}</span>
                  <span class="queued-draft-text">{{ queuedDraftSummary }}</span>
                </div>
                <button v-if="queuedDraftCount > 1" class="queued-draft-clear" @click="clearQueuedDrafts">Clear all</button>
              </div>
              <div class="queued-draft-list">
                <div v-for="(draft, index) in queuedDrafts" :key="draft.id" class="queued-draft-item">
                  <div class="queued-draft-item-copy">
                    <span class="queued-draft-item-order">{{ index + 1 }}.</span>
                    <span class="queued-draft-item-mode">{{ getQueuedDraftModeLabel(draft.mode) }}</span>
                    <span class="queued-draft-item-text">{{ draft.text }}</span>
                  </div>
                  <div class="queued-draft-actions">
                    <button class="queued-draft-shift" :disabled="index === 0" @click="moveQueuedDraft(draft.id, -1)">↑</button>
                    <button class="queued-draft-shift" :disabled="index === queuedDraftCount - 1" @click="moveQueuedDraft(draft.id, 1)">↓</button>
                    <button class="queued-draft-remove" @click="removeQueuedDraft(draft.id)">Remove</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="input-wrapper" :class="{ disabled: composerDisabled }">
              <textarea
                ref="inputEl"
                v-model="input"
                class="chat-input"
                :placeholder="isRunning
                  ? 'Current run is active. Type to stop, steer, or queue the next message...'
                  : 'Ask Bliss Agent to write, edit, or explain code...'"
                :disabled="composerDisabled"
                @keydown.enter.exact.prevent="handleComposerSubmit"
                @keydown.enter.shift.exact="input += '\n'"
                @input="autoResize"
              ></textarea>
              <div class="input-actions">
                <button
                  v-if="isRunning && activeToolState.tool"
                  class="composer-btn composer-btn-secondary"
                  :disabled="activeToolState.cancelling || isCancelling"
                  @click="stopActiveTool"
                >
                  {{ activeToolState.cancelling ? 'Stopping tool...' : `Stop ${activeToolLabel}` }}
                </button>
                <button
                  v-if="isRunning"
                  class="composer-btn composer-btn-secondary"
                  :disabled="isCancelling || !activeRunId"
                  @click="stopRun"
                >
                  {{ isCancelling ? 'Stopping...' : 'Stop' }}
                </button>
                <button
                  v-if="isRunning && canQueueDraft"
                  class="composer-btn composer-btn-secondary"
                  :disabled="isCancelling"
                  @click="stopAndSendDraft"
                >
                  Stop &amp; Send
                </button>
                <button
                  v-if="isRunning && canQueueDraft"
                  class="composer-btn composer-btn-secondary"
                  :disabled="isCancelling"
                  @click="queueDraft('steer')"
                >
                  Steer Next
                </button>
                <button
                  v-if="isRunning && canQueueDraft"
                  class="composer-btn composer-btn-secondary"
                  :disabled="isCancelling"
                  @click="queueDraft('queue')"
                >
                  Queue
                </button>
                <button class="composer-btn composer-btn-primary composer-btn-icon" :disabled="!canSend" @click="send">
                  <span>↑</span>
                </button>
              </div>
            </div>
            <div class="input-hint-row">
              <div class="input-hint">{{ composerHint }}</div>
              <div class="context-meter-inline" :class="contextMeterTone" :title="contextMeterSummary">
                <span class="context-meter-inline-label">Context</span>
                <div class="context-meter-inline-bar">
                  <span class="context-meter-inline-fill" :style="{ width: `${contextUsagePercent}%` }"></span>
                </div>
                <span class="context-meter-inline-value">{{ contextUsagePercent }}%</span>
                <button v-if="chatContextSummary.text" class="context-meter-inline-toggle" @click="contextSummaryExpanded = !contextSummaryExpanded">
                  {{ contextSummaryExpanded ? 'Hide' : 'Summary' }}
                </button>
              </div>
            </div>
            <div v-if="contextSummaryExpanded && chatContextSummary.text" class="context-summary-card">{{ chatContextSummary.text }}</div>
          </div>
        </section>

        <div
          v-if="previewOpen"
          class="preview-resize-handle"
          @mousedown="startPreviewResize"
        ></div>

        <aside
          v-if="previewOpen"
          class="preview-pane"
          :class="{ empty: !previewState.path }"
          :style="{ width: `${previewWidth}px` }"
        >
          <div class="preview-header">
            <div>
              <div class="preview-title">File Viewer</div>
              <div class="preview-subtitle">{{ previewState.path || 'Select a file result to preview content' }}</div>
            </div>
            <div v-if="previewState.path" class="preview-actions">
              <span v-if="previewLanguage" class="preview-language">{{ previewLanguage }}</span>
              <button class="preview-copy" @click="copyPreviewContent">{{ previewCopyState || 'Copy' }}</button>
              <button class="preview-close" @click="clearPreview">×</button>
            </div>
          </div>

          <div v-if="previewLoading" class="preview-status">Loading preview...</div>
          <div v-else-if="previewError" class="preview-status error">{{ previewError }}</div>
          <div v-else-if="previewState.path" class="preview-body">
            <div class="preview-meta">
              <span>Lines {{ previewState.startLine }}-{{ previewState.endLine }}</span>
              <span v-if="previewState.focusLine">Focus L{{ previewState.focusLine }}</span>
              <span>Total {{ previewState.totalLines }}</span>
            </div>
            <pre class="preview-code hljs"><code v-html="highlightedPreviewContent"></code></pre>
          </div>
          <div v-else class="preview-status">Search results and file matches become clickable here.</div>
        </aside>
      </div>
    </main>

    <div v-if="settingsOpen" class="settings-overlay" @click.self="closeSettings">
      <aside class="settings-panel">
        <div class="settings-header">
          <div>
            <div class="settings-eyebrow">WORKSPACE SETTINGS</div>
            <h3 class="settings-title">Configure Bliss Agent</h3>
            <p class="settings-subtitle">Provider credentials and tool inventory live here so the sidebar stays focused on execution state.</p>
          </div>
          <button class="settings-close" @click="closeSettings">×</button>
        </div>

        <div class="settings-tabs" role="tablist" aria-label="Settings sections">
          <button
            class="settings-tab"
            :class="{ active: settingsTab === 'provider' }"
            @click="settingsTab = 'provider'"
          >Provider</button>
          <button
            class="settings-tab"
            :class="{ active: settingsTab === 'github' }"
            @click="settingsTab = 'github'"
          >GitHub</button>
          <button
            class="settings-tab"
            :class="{ active: settingsTab === 'tools' }"
            @click="settingsTab = 'tools'"
          >Tools</button>
        </div>

        <div v-if="settingsTab === 'provider'" class="settings-section">
          <div class="settings-section-header">
              <label class="settings-label">MODEL PROVIDER</label>
              <span class="settings-badge" :class="{ warning: apiKeyMissing }">{{ apiKeyMissing ? 'Required' : 'Configured' }}</span>
          </div>
            <div class="provider-grid">
              <button
                v-for="option in providerOptions"
                :key="option.id"
                class="provider-card"
                :class="{ active: provider === option.id }"
                @click="selectProvider(option.id)"
              >
                <div class="provider-card-head">
                  <span class="provider-card-title">{{ option.label }}</span>
                  <span class="provider-card-tag">{{ option.tag }}</span>
                </div>
                <div class="provider-card-body">{{ option.description }}</div>
                <div class="provider-card-runtime" :class="getProviderRuntimeTone(option.id)">{{ getProviderRuntimeSummary(option.id) }}</div>
              </button>
            </div>
            <label class="settings-label settings-sub-label">{{ activeProvider.inputLabel }}</label>
          <input
              v-model="selectedApiKey"
            type="password"
            class="api-input settings-input"
              :placeholder="activeProvider.placeholder"
              @change="saveActiveApiKey"
          />
          <div class="settings-hint-row">
            <span class="key-hint">Saved locally on this machine.</span>
              <span class="key-hint">{{ activeProvider.hint }}</span>
          </div>
            <p class="settings-copy settings-copy-tight">{{ activeProvider.longDescription }}</p>
        </div>

        <div v-else-if="settingsTab === 'github'" class="settings-section">
          <div class="settings-section-header">
            <label class="settings-label">GITHUB</label>
            <span class="settings-badge">gh workflow</span>
          </div>
          <div class="github-status-card settings-github-card" :class="[githubStatusTone, { clickable: githubStatusLoginAvailable }]" @click="handleGitHubStatusClick">
            <div class="github-status-head">
              <span class="github-status-dot"></span>
              <span>{{ githubStatusLabel }}</span>
            </div>
            <div class="github-status-body">{{ githubStatusDetail }}</div>
          </div>
          <button v-if="githubStatusLoginAvailable" class="settings-primary-btn" @click="handleGitHubStatusClick">
            Sign in with GitHub
          </button>
          <div class="settings-facts">
            <div class="settings-fact">
              <span class="settings-fact-label">Account</span>
              <span class="settings-fact-value">{{ githubStatus.account || 'Not authenticated' }}</span>
            </div>
            <div class="settings-fact">
              <span class="settings-fact-label">Repository</span>
              <span class="settings-fact-value">{{ githubStatus.repoSlug || 'No GitHub remote detected' }}</span>
            </div>
            <div class="settings-fact">
              <span class="settings-fact-label">Branch</span>
              <span class="settings-fact-value">{{ githubStatus.branch || 'Unknown' }}</span>
            </div>
          </div>
          <p class="settings-copy settings-copy-tight">Bliss Agent can now read GitHub repository, issue and pull request context through the installed GitHub CLI.</p>
        </div>

        <div v-else class="settings-section">
          <div class="settings-section-header">
            <label class="settings-label">TOOLS</label>
            <span class="settings-badge">Approval gated</span>
          </div>
          <div class="settings-budget-card">
            <div class="settings-budget-head">
              <div class="settings-budget-copy-block">
                <label class="settings-label settings-inline-label">ITERATION BUDGET</label>
                <div class="settings-budget-value">{{ iterationBudget }} loops per block</div>
              </div>
              <span class="settings-badge">{{ iterationBudget }} loops</span>
            </div>
            <p class="settings-copy settings-copy-tight settings-budget-copy">Implementation runs use this many loops before Bliss Agent pauses and asks whether it may continue with another block of the same size.</p>
            <div class="settings-budget-controls">
              <button class="settings-budget-stepper" type="button" @click="adjustIterationBudget(-1)">−</button>
              <input
                v-model="iterationBudget"
                type="number"
                min="5"
                max="60"
                class="settings-input settings-budget-input"
                @change="saveIterationBudget"
              />
              <button class="settings-budget-stepper" type="button" @click="adjustIterationBudget(1)">+</button>
            </div>
            <div class="settings-budget-foot">
              <span class="settings-budget-meta">Applies to each autonomous implementation block.</span>
              <span class="settings-budget-range">Min 5 · Max 60</span>
            </div>
          </div>
          <p class="settings-copy">This is the current local tool surface available to the agent for the selected working directory. Mutating and risky actions are approval-gated in the chat before execution.</p>
          <div class="settings-tools-grid">
            <div v-for="t in toolsList" :key="t.name" class="settings-tool-item">
              <span class="tool-icon">{{ t.icon }}</span>
              <div class="settings-tool-meta">
                <span class="settings-tool-label">{{ t.label }}</span>
                <span class="settings-tool-name">{{ t.name }}</span>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import hljs from 'highlight.js/lib/common'

const CHAT_SESSIONS_STORAGE_KEY = 'bliss_chat_sessions'
const ACTIVE_CHAT_STORAGE_KEY = 'bliss_active_chat_id'
const QUEUED_DRAFTS_STORAGE_KEY = 'bliss_queued_drafts'
const ITERATION_BUDGET_STORAGE_KEY = 'bliss_iteration_budget'
const TOOL_RESULT_COLLAPSED_COUNT = 3
const CHAT_CONTEXT_BUDGET_CHARS = 24000
const CHAT_CONTEXT_COMPACT_TARGET_RATIO = 0.58
const CHAT_CONTEXT_KEEP_RECENT_USER_TURNS = 6
const CHAT_CONTEXT_MIN_USER_TURNS = 3
const CHAT_CONTEXT_KEEP_MIN_MESSAGES = 8
const CHAT_CONTEXT_SUMMARY_MAX_CHARS = 2800
const CHAT_CONTEXT_SUMMARY_MARKER = '[[BLISS_CONTEXT_SUMMARY]]'

function normalizeIterationBudget(value, fallback = 15) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return fallback
  return Math.max(5, Math.min(Math.round(numericValue), 60))
}

function normalizeContextSummary(value) {
  const normalized = value && typeof value === 'object' ? value : {}
  return {
    text: typeof normalized.text === 'string' ? normalized.text.trim() : '',
    compactedCount: Math.max(0, Number(normalized.compactedCount) || 0),
    compactedMessages: Math.max(0, Number(normalized.compactedMessages) || 0),
    lastCompactedAt: Math.max(0, Number(normalized.lastCompactedAt) || 0),
  }
}

function getHistoryMessageText(message) {
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) {
    return message.content.map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object' && typeof entry.text === 'string') return entry.text
      return ''
    }).join('\n')
  }
  if (message?.content && typeof message.content === 'object') {
    try {
      return JSON.stringify(message.content)
    } catch {
      return ''
    }
  }
  return ''
}

function normalizeInlineText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function truncateInlineText(value, maxLength = 160) {
  const normalized = normalizeInlineText(value)
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3).trim()}...`
}

function truncateMultilineText(value, maxLength = CHAT_CONTEXT_SUMMARY_MAX_CHARS) {
  const text = String(value || '').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3).trim()}...`
}

function stripMarkdownToPlainText(value) {
  return normalizeInlineText(String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_>#~-]+/g, ' '))
}

function isInternalHistoryMessage(value) {
  const normalized = normalizeInlineText(value)
  return normalized.startsWith('Automatic recovery required:')
    || normalized.startsWith('Tool-use correction:')
    || normalized.startsWith('The previous response was truncated by the model.')
    || normalized.startsWith('Continue the previous task from the current state until')
}

function isContextSummaryMessage(message) {
  return message?.role === 'assistant'
    && typeof message?.content === 'string'
    && message.content.startsWith(CHAT_CONTEXT_SUMMARY_MARKER)
}

function splitStoredContextSummary(history, fallbackSummary = null) {
  const normalizedSummary = normalizeContextSummary(fallbackSummary)
  const nextHistory = Array.isArray(history) ? history.slice() : []

  if (nextHistory.length && isContextSummaryMessage(nextHistory[0])) {
    return {
      history: nextHistory.slice(1),
      summary: {
        ...normalizedSummary,
        text: nextHistory[0].content.slice(CHAT_CONTEXT_SUMMARY_MARKER.length).trim() || normalizedSummary.text,
      },
    }
  }

  return { history: nextHistory, summary: normalizedSummary }
}

function buildContextSummaryHistoryMessage(summaryState) {
  const normalizedSummary = normalizeContextSummary(summaryState)
  if (!normalizedSummary.text) return null

  return {
    role: 'assistant',
    content: `${CHAT_CONTEXT_SUMMARY_MARKER}\n${normalizedSummary.text}`,
  }
}

function getHistoryMessageSize(message) {
  return String(message?.role || '').length + getHistoryMessageText(message).length + 12
}

function estimateContextUsage(history, summaryState, pendingUserText = '') {
  const summaryMessage = buildContextSummaryHistoryMessage(summaryState)
  let total = summaryMessage ? getHistoryMessageSize(summaryMessage) : 0

  for (const message of Array.isArray(history) ? history : []) {
    total += getHistoryMessageSize(message)
  }

  if (pendingUserText) {
    total += String(pendingUserText).length + 16
  }

  return total
}

function getContextUsagePercent(history, summaryState, pendingUserText = '') {
  return Math.max(0, Math.min(100, Math.round((estimateContextUsage(history, summaryState, pendingUserText) / CHAT_CONTEXT_BUDGET_CHARS) * 100)))
}

function pushUniqueCapped(list, value, maxItems) {
  if (!value || list.includes(value)) return
  list.push(value)
  if (list.length > maxItems) {
    list.splice(0, list.length - maxItems)
  }
}

function extractFileReferencesFromText(value) {
  const matches = String(value || '').match(/[A-Za-z0-9_./\\-]+\.(?:vue|[cm]?[jt]sx?|cs|py|json|md|css|html)\b/g) || []
  return matches.map((entry) => entry.replace(/\\/g, '/'))
}

function summarizeToolHistoryMessage(value) {
  try {
    const parsed = JSON.parse(value)
    if (parsed?.path && typeof parsed.startLine === 'number') {
      const endLine = typeof parsed.endLine === 'number' ? parsed.endLine : parsed.startLine
      return truncateInlineText(`Read ${parsed.path}:${parsed.startLine}-${endLine}`, 140)
    }
    if (parsed?.path) {
      return truncateInlineText(`${parsed.success === false ? 'Failed on' : 'Touched'} ${parsed.path}`, 140)
    }
    if (parsed?.command) {
      const exitSuffix = typeof parsed.exitCode === 'number' ? ` (exit ${parsed.exitCode})` : ''
      return truncateInlineText(`Ran ${parsed.command}${exitSuffix}`, 140)
    }
    if (typeof parsed?.message === 'string') {
      return truncateInlineText(stripMarkdownToPlainText(parsed.message), 140)
    }
    if (typeof parsed?.error === 'string') {
      return truncateInlineText(stripMarkdownToPlainText(parsed.error), 140)
    }
  } catch {
  }

  return truncateInlineText(stripMarkdownToPlainText(value), 140)
}

function buildCompactedContextText(compactedHistory, previousSummary) {
  const priorSummary = normalizeContextSummary(previousSummary)
  const userRequests = []
  const assistantOutcomes = []
  const toolNotes = []
  const fileReferences = []

  for (const message of Array.isArray(compactedHistory) ? compactedHistory : []) {
    const content = getHistoryMessageText(message)
    if (!content) continue

    for (const fileRef of extractFileReferencesFromText(content)) {
      pushUniqueCapped(fileReferences, fileRef, 8)
    }

    if (message.role === 'user') {
      if (isInternalHistoryMessage(content)) continue
      pushUniqueCapped(userRequests, truncateInlineText(stripMarkdownToPlainText(content), 140), 6)
      continue
    }

    if (message.role === 'assistant') {
      if (isContextSummaryMessage(message)) continue
      pushUniqueCapped(assistantOutcomes, truncateInlineText(stripMarkdownToPlainText(content), 140), 6)
      continue
    }

    if (message.role === 'tool') {
      pushUniqueCapped(toolNotes, summarizeToolHistoryMessage(content), 6)
    }
  }

  const sections = ['Earlier chat context was compacted to keep the live prompt small.']

  if (priorSummary.text) {
    sections.push(`Previously compacted context:\n${priorSummary.text}`)
  }

  if (userRequests.length) {
    sections.push(`User requests:\n- ${userRequests.join('\n- ')}`)
  }

  if (assistantOutcomes.length) {
    sections.push(`Key outcomes:\n- ${assistantOutcomes.join('\n- ')}`)
  }

  if (fileReferences.length) {
    sections.push(`Relevant files:\n- ${fileReferences.join('\n- ')}`)
  }

  if (toolNotes.length) {
    sections.push(`Tool and validation notes:\n- ${toolNotes.join('\n- ')}`)
  }

  sections.push('Use this summary as background memory only. The recent live turns below remain the source of current detail.')

  return truncateMultilineText(sections.join('\n\n'))
}

function getExternalUserMessageIndices(history) {
  const indices = []
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index]
    if (message?.role !== 'user') continue
    if (isInternalHistoryMessage(getHistoryMessageText(message))) continue
    indices.push(index)
  }
  return indices
}

function findContextCompactionSplitIndex(history, summaryState, pendingUserText = '') {
  const userIndices = getExternalUserMessageIndices(history)
  const targetUsage = CHAT_CONTEXT_BUDGET_CHARS * CHAT_CONTEXT_COMPACT_TARGET_RATIO

  if (userIndices.length > CHAT_CONTEXT_KEEP_RECENT_USER_TURNS) {
    let keepTurns = CHAT_CONTEXT_KEEP_RECENT_USER_TURNS
    let splitIndex = userIndices[userIndices.length - keepTurns]

    while (splitIndex > 0 && keepTurns > CHAT_CONTEXT_MIN_USER_TURNS) {
      const liveHistory = history.slice(splitIndex)
      if (estimateContextUsage(liveHistory, summaryState, pendingUserText) <= targetUsage) {
        return splitIndex
      }
      keepTurns -= 1
      splitIndex = userIndices[userIndices.length - keepTurns]
    }

    if (splitIndex > 0) return splitIndex
  }

  if (history.length > CHAT_CONTEXT_KEEP_MIN_MESSAGES) {
    return Math.max(1, history.length - CHAT_CONTEXT_KEEP_MIN_MESSAGES)
  }

  return 0
}

function trimLiveHistoryAfterCompaction(history, summaryState, pendingUserText = '') {
  const targetUsage = CHAT_CONTEXT_BUDGET_CHARS * CHAT_CONTEXT_COMPACT_TARGET_RATIO
  const nextHistory = Array.isArray(history) ? history.slice() : []

  while (nextHistory.length > CHAT_CONTEXT_KEEP_MIN_MESSAGES && estimateContextUsage(nextHistory, summaryState, pendingUserText) > targetUsage) {
    nextHistory.shift()
  }

  return nextHistory
}

function compactChatContext(history, summaryState, pendingUserText = '') {
  const normalizedState = splitStoredContextSummary(history, summaryState)
  const currentPercent = getContextUsagePercent(normalizedState.history, normalizedState.summary, pendingUserText)

  if (currentPercent < 100) {
    return {
      history: normalizedState.history,
      summary: normalizedState.summary,
      compacted: false,
      percent: currentPercent,
    }
  }

  const splitIndex = findContextCompactionSplitIndex(normalizedState.history, normalizedState.summary, pendingUserText)
  if (splitIndex <= 0) {
    return {
      history: normalizedState.history,
      summary: normalizedState.summary,
      compacted: false,
      percent: currentPercent,
    }
  }

  const archivedHistory = normalizedState.history.slice(0, splitIndex)
  let liveHistory = normalizedState.history.slice(splitIndex)
  const nextSummary = {
    ...normalizedState.summary,
    text: buildCompactedContextText(archivedHistory, normalizedState.summary),
    compactedCount: normalizedState.summary.compactedCount + 1,
    compactedMessages: normalizedState.summary.compactedMessages + archivedHistory.length,
    lastCompactedAt: Date.now(),
  }

  liveHistory = trimLiveHistoryAfterCompaction(liveHistory, nextSummary, pendingUserText)

  return {
    history: liveHistory,
    summary: nextSummary,
    compacted: true,
    percent: getContextUsagePercent(liveHistory, nextSummary, pendingUserText),
  }
}

function buildHistoryForRun(history, summaryState) {
  const normalizedState = splitStoredContextSummary(history, summaryState)
  const summaryMessage = buildContextSummaryHistoryMessage(normalizedState.summary)
  return summaryMessage ? [summaryMessage, ...normalizedState.history] : normalizedState.history
}

function loadPersistedQueuedDrafts() {
  try {
    const raw = localStorage.getItem(QUEUED_DRAFTS_STORAGE_KEY)
    if (!raw) return []

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((draft) => draft && typeof draft.id === 'string' && typeof draft.mode === 'string' && typeof draft.text === 'string')
      .slice(0, 20)
  } catch {
    return []
  }
}

function saveQueuedDrafts() {
  try {
    if (!queuedDrafts.value.length) {
      localStorage.removeItem(QUEUED_DRAFTS_STORAGE_KEY)
      return
    }

    localStorage.setItem(QUEUED_DRAFTS_STORAGE_KEY, JSON.stringify(queuedDrafts.value.slice(0, 20)))
  } catch {
  }
}

function createChatId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function getChatTitleFromState(displayMessages = [], messages = []) {
  const displayUserMessage = displayMessages.find((message) => message?.type === 'user' && typeof message.content === 'string' && message.content.trim())
  if (displayUserMessage) {
    return displayUserMessage.content.trim().slice(0, 42)
  }

  const historyUserMessage = messages.find((message) => message?.role === 'user' && typeof message.content === 'string' && message.content.trim())
  if (historyUserMessage) {
    return historyUserMessage.content.trim().slice(0, 42)
  }

  return 'New chat'
}

function normalizeChatTitle(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ')
  return normalized || 'New chat'
}

function createEmptyChatSession(overrides = {}) {
  const displayMessages = Array.isArray(overrides.displayMessages) ? overrides.displayMessages : []
  const normalizedSummaryState = splitStoredContextSummary(overrides.messages, overrides.contextSummary)
  const messages = normalizedSummaryState.history
  const hasCustomTitle = Boolean(overrides.titleManuallySet)
  const computedTitle = hasCustomTitle
    ? normalizeChatTitle(overrides.title)
    : getChatTitleFromState(displayMessages, messages)

  return {
    id: overrides.id || createChatId(),
    title: computedTitle,
    titleManuallySet: hasCustomTitle,
    workingDir: overrides.workingDir || '',
    input: overrides.input || '',
    messages,
    displayMessages,
    modelEvents: Array.isArray(overrides.modelEvents) ? overrides.modelEvents : [],
    validationRuns: Array.isArray(overrides.validationRuns) ? overrides.validationRuns : [],
    changeEvents: Array.isArray(overrides.changeEvents) ? overrides.changeEvents : [],
    iterationStateByTurn: overrides.iterationStateByTurn && typeof overrides.iterationStateByTurn === 'object' ? overrides.iterationStateByTurn : {},
    workflowExpandedByTurn: overrides.workflowExpandedByTurn && typeof overrides.workflowExpandedByTurn === 'object' ? overrides.workflowExpandedByTurn : {},
    stoppedTurns: overrides.stoppedTurns && typeof overrides.stoppedTurns === 'object' ? overrides.stoppedTurns : {},
    latestWorkflowTurnId: overrides.latestWorkflowTurnId || null,
    approvalPolicy: overrides.approvalPolicy && typeof overrides.approvalPolicy === 'object'
      ? {
          allowAll: Boolean(overrides.approvalPolicy.allowAll),
          allowedTools: overrides.approvalPolicy.allowedTools && typeof overrides.approvalPolicy.allowedTools === 'object'
            ? overrides.approvalPolicy.allowedTools
            : {},
        }
      : { allowAll: false, allowedTools: {} },
    conversationModelProvider: overrides.conversationModelProvider || '',
    conversationModelLabel: overrides.conversationModelLabel || '',
    conversationModelMeta: overrides.conversationModelMeta || '',
    providerRuntimeState: overrides.providerRuntimeState && typeof overrides.providerRuntimeState === 'object' ? overrides.providerRuntimeState : {},
    contextSummary: normalizedSummaryState.summary,
    contextSummaryExpanded: Boolean(overrides.contextSummaryExpanded),
    queuedDrafts: Array.isArray(overrides.queuedDrafts) ? overrides.queuedDrafts.slice(0, 20) : [],
    updatedAt: Number(overrides.updatedAt) || Date.now(),
  }
}

function loadPersistedChatSessions() {
  try {
    const raw = localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY)
    if (!raw) {
      return [createEmptyChatSession({
        workingDir: localStorage.getItem('bliss_working_dir') || '',
        queuedDrafts: loadPersistedQueuedDrafts(),
      })]
    }

    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.length) {
      return [createEmptyChatSession({
        workingDir: localStorage.getItem('bliss_working_dir') || '',
        queuedDrafts: loadPersistedQueuedDrafts(),
      })]
    }

    return parsed.slice(0, 20).map((session) => createEmptyChatSession(session))
  } catch {
    return [createEmptyChatSession({
      workingDir: localStorage.getItem('bliss_working_dir') || '',
      queuedDrafts: loadPersistedQueuedDrafts(),
    })]
  }
}

function saveChatSessions() {
  try {
    localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(chatSessions.value.slice(0, 20)))
    localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, activeChatId.value)
  } catch {
  }
}

const initialChatSessions = loadPersistedChatSessions()
const persistedActiveChatId = localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY)
const initialActiveChat = initialChatSessions.find((chat) => chat.id === persistedActiveChatId) || initialChatSessions[0]

// ─── State ───────────────────────────────────────────────────────────────────

const provider = ref(localStorage.getItem('bliss_provider') || 'openrouter')
const openRouterApiKey = ref(localStorage.getItem('bliss_openrouter_api_key') || localStorage.getItem('bliss_api_key') || '')
const geminiApiKey = ref(localStorage.getItem('bliss_gemini_api_key') || '')
const iterationBudget = ref(normalizeIterationBudget(localStorage.getItem(ITERATION_BUDGET_STORAGE_KEY), 15))
const chatSessions = ref(initialChatSessions)
const activeChatId = ref(initialActiveChat.id)
const isApplyingChatState = ref(false)
const activeChatTitle = ref(initialActiveChat.title || 'New chat')
const activeChatTitleManuallySet = ref(Boolean(initialActiveChat.titleManuallySet))
const workingDir = ref(initialActiveChat.workingDir || localStorage.getItem('bliss_working_dir') || '')
const input = ref(initialActiveChat.input || '')
const isRunning = ref(false)
const messages = ref(initialActiveChat.messages || []) // { role, content } for API history
const displayMessages = ref(initialActiveChat.displayMessages || []) // { type, content, tool, args, result } for UI
const modelEvents = ref(initialActiveChat.modelEvents || [])
const validationRuns = ref(initialActiveChat.validationRuns || [])
const changeEvents = ref(initialActiveChat.changeEvents || [])
const iterationStateByTurn = ref(initialActiveChat.iterationStateByTurn || {})
const previewOpen = ref(false)
const previewWidth = ref(380)
const previewState = ref({ path: '', content: '', startLine: 0, endLine: 0, focusLine: null, totalLines: 0 })
const previewLoading = ref(false)
const previewError = ref('')
const previewCopyState = ref('')
const settingsOpen = ref(false)
const settingsTab = ref('provider')
const workflowExpandedByTurn = ref(initialActiveChat.workflowExpandedByTurn || {})
const stoppedTurns = ref(initialActiveChat.stoppedTurns || {})
const latestWorkflowTurnId = ref(initialActiveChat.latestWorkflowTurnId || null)
const activeRunId = ref('')
const isCancelling = ref(false)
const activeToolState = ref({ tool: '', cancelling: false })
const approvalPolicy = ref(initialActiveChat.approvalPolicy || { allowAll: false, allowedTools: {} })
const conversationModelProvider = ref(initialActiveChat.conversationModelProvider || '')
const conversationModelLabel = ref(initialActiveChat.conversationModelLabel || '')
const conversationModelMeta = ref(initialActiveChat.conversationModelMeta || '')
const providerRuntimeState = ref(initialActiveChat.providerRuntimeState || {})
const chatContextSummary = ref(normalizeContextSummary(initialActiveChat.contextSummary))
const contextSummaryExpanded = ref(Boolean(initialActiveChat.contextSummaryExpanded))
const queuedDrafts = ref(initialActiveChat.queuedDrafts || [])
const messagesEl = ref(null)
const inputEl = ref(null)
const chatRenameInputEl = ref(null)
const editingChatId = ref('')
const editingChatTitle = ref('')
const providerOptions = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    tag: 'Free mix',
    description: 'Current Bliss behavior with Qwen first, then Qwen Next, then the generic OpenRouter free fallback.',
    modelLabel: 'qwen3-coder',
    modelMeta: 'Fallback: Qwen -> Qwen Next -> OpenRouter Free',
    inputLabel: 'OPENROUTER KEY',
    placeholder: 'sk-or-...',
    hint: 'Free tier · multi-model fallback',
    longDescription: 'Uses the current OpenRouter flow with the remaining compatible free fallback chain for coding and tool use: Qwen first, then Qwen Next, then the generic OpenRouter free fallback.',
    storageKey: 'bliss_openrouter_api_key',
  },
  {
    id: 'gemini',
    label: 'Gemini AI Studio',
    tag: 'AI Studio',
    description: 'Google AI Studio via the OpenAI-compatible chat completions endpoint with model fallback for tool use.',
    modelLabel: 'gemini-2.5-flash',
    modelMeta: 'Fallback: 2.5 Flash -> 2.5 Flash-Lite -> 2.0 Flash',
    inputLabel: 'GOOGLE AI STUDIO KEY',
    placeholder: 'AIza...',
    hint: 'Gemini AI Studio · Tool-capable fallback',
    longDescription: 'Uses Gemini AI Studio with a fallback chain tuned for agent/tool use on free-tier limits: 2.5 Flash, then 2.5 Flash-Lite, then 2.0 Flash.',
    storageKey: 'bliss_gemini_api_key',
  },
]
const githubStatus = ref({
  loading: false,
  available: false,
  authenticated: false,
  account: '',
  repo: false,
  repoSlug: '',
  branch: '',
  authMessage: '',
  repoMessage: '',
  message: 'Select a working directory to inspect GitHub status.',
})

const toolsList = [
  { name: 'find_files', icon: '⌕', label: 'Find files' },
  { name: 'search_text', icon: '≣', label: 'Search text' },
  { name: 'read_file', icon: '◎', label: 'Read file' },
  { name: 'read_file_range', icon: '◱', label: 'Read file range' },
  { name: 'apply_patch', icon: '✎', label: 'Apply patch' },
  { name: 'write_file', icon: '◉', label: 'Write file' },
  { name: 'list_directory', icon: '◫', label: 'List directory' },
  { name: 'git_status', icon: '⑂', label: 'Git status' },
  { name: 'git_diff', icon: 'Δ', label: 'Git diff' },
  { name: 'git_create_branch', icon: '⑃', label: 'Create branch' },
  { name: 'git_add', icon: '⊕', label: 'Git add' },
  { name: 'git_commit', icon: '✓', label: 'Git commit' },
  { name: 'github_auth_status', icon: '⌘', label: 'GitHub status' },
  { name: 'github_repo_info', icon: '⌂', label: 'GitHub repo info' },
  { name: 'github_issue_list', icon: '⋯', label: 'GitHub issue list' },
  { name: 'github_issue_view', icon: '◌', label: 'GitHub issue view' },
  { name: 'github_issue_create', icon: '⊕', label: 'GitHub issue create' },
  { name: 'github_issue_edit', icon: '≡', label: 'GitHub issue edit' },
  { name: 'github_issue_close', icon: '⊘', label: 'GitHub issue close' },
  { name: 'github_issue_reopen', icon: '↺', label: 'GitHub issue reopen' },
  { name: 'github_issue_comment', icon: '✎', label: 'GitHub issue comment' },
  { name: 'github_pr_list', icon: '⋮', label: 'GitHub PR list' },
  { name: 'github_pr_view', icon: '◍', label: 'GitHub PR view' },
  { name: 'github_pr_checks', icon: '☰', label: 'GitHub PR checks' },
  { name: 'github_pr_review_comments', icon: '✦', label: 'PR review comments' },
  { name: 'github_pr_review_threads', icon: '⟟', label: 'PR review threads' },
  { name: 'github_pr_edit', icon: '≣', label: 'GitHub PR edit' },
  { name: 'github_pr_review_submit', icon: '☑', label: 'GitHub PR review' },
  { name: 'github_pr_review_thread_reply', icon: '↪', label: 'PR thread reply' },
  { name: 'github_pr_review_thread_resolve', icon: '⌗', label: 'PR thread resolve' },
  { name: 'github_pr_close', icon: '⊖', label: 'GitHub PR close' },
  { name: 'github_pr_reopen', icon: '↻', label: 'GitHub PR reopen' },
  { name: 'github_pr_comment', icon: '✐', label: 'GitHub PR comment' },
  { name: 'github_pr_merge', icon: '⇉', label: 'GitHub PR merge' },
  { name: 'github_pr_ready', icon: '◉', label: 'GitHub PR ready/draft' },
  { name: 'github_pr_create', icon: '⇪', label: 'GitHub draft PR' },
  { name: 'run_build', icon: '⚒', label: 'Run build' },
  { name: 'run_test', icon: '🧪', label: 'Run test' },
  { name: 'run_lint', icon: '☑', label: 'Run lint' },
  { name: 'run_command', icon: '▶', label: 'Run command' },
  { name: 'create_directory', icon: '⊞', label: 'Create directory' },
  { name: 'delete_file', icon: '⊗', label: 'Delete file' },
]

const suggestions = [
  'List the files in this project',
  'Create a new .NET service class',
  'Run dotnet build and fix any errors',
  'Explain the project structure',
]

// ─── Computed ─────────────────────────────────────────────────────────────────

const draftText = computed(() => input.value.trim())

const canSend = computed(() => {
  return Boolean(draftText.value && selectedApiKey.value.trim() && !isRunning.value)
})

const composerDisabled = computed(() => !selectedApiKey.value.trim())

const canQueueDraft = computed(() => {
  return Boolean(draftText.value && selectedApiKey.value.trim() && isRunning.value)
})

const activeProvider = computed(() => {
  return providerOptions.find((option) => option.id === provider.value) || providerOptions[0]
})

function getProviderOptionById(providerId) {
  return providerOptions.find((option) => option.id === providerId) || null
}

const selectedApiKey = computed({
  get() {
    return provider.value === 'gemini' ? geminiApiKey.value : openRouterApiKey.value
  },
  set(value) {
    if (provider.value === 'gemini') {
      geminiApiKey.value = value
      return
    }

    openRouterApiKey.value = value
  },
})

const activeModelLabel = computed(() => {
  if (conversationModelProvider.value === provider.value && conversationModelLabel.value) {
    return conversationModelLabel.value
  }

  return activeProvider.value.modelLabel
})

const activeModelMeta = computed(() => {
  if (conversationModelProvider.value === provider.value && conversationModelMeta.value) {
    return conversationModelMeta.value
  }

  return activeProvider.value.modelMeta
})

const activeFallbackSummary = computed(() => {
  return providerRuntimeState.value[provider.value]?.summary || ''
})

const activeFallbackTone = computed(() => {
  return providerRuntimeState.value[provider.value]?.tone || ''
})

const apiKeyMissing = computed(() => !selectedApiKey.value.trim())

const pendingApprovalCount = computed(() => displayMessages.value.filter((message) => message.type === 'approval' && !message.resolved).length)

const activeToolLabel = computed(() => {
  if (!activeToolState.value.tool) return 'Tool'
  return toolsList.find((tool) => tool.name === activeToolState.value.tool)?.label || activeToolState.value.tool
})

const activeApprovalToolLabels = computed(() => {
  return Object.entries(approvalPolicy.value.allowedTools || {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([toolName]) => toolsList.find((tool) => tool.name === toolName)?.label || toolName)
})

const hasActiveApprovalPolicy = computed(() => {
  return approvalPolicy.value.allowAll || activeApprovalToolLabels.value.length > 0
})

const activeApprovalPolicySummary = computed(() => {
  if (approvalPolicy.value.allowAll) {
    return 'All approval-gated commands will auto-run in this chat.'
  }

  if (activeApprovalToolLabels.value.length === 1) {
    return `${activeApprovalToolLabels.value[0]} will auto-run in this chat.`
  }

  return `${activeApprovalToolLabels.value.join(', ')} will auto-run in this chat.`
})

const composerHint = computed(() => {
  if (composerDisabled.value) return 'Add an API key to send messages'
  if (activeToolState.value.cancelling) return `Cancelling ${activeToolLabel.value}...`
  if (pendingApprovalCount.value) return `${pendingApprovalCount.value} approval ${pendingApprovalCount.value === 1 ? 'request is' : 'requests are'} waiting · approve or deny to continue`
  if (activeToolState.value.tool) return `${activeToolLabel.value} is running · stop the tool or stop the whole run`
  if (queuedDraftCount.value) return `${queuedDraftCount.value} queued ${queuedDraftCount.value === 1 ? 'message' : 'messages'} · Enter queues another draft · Shift+Enter for newline`
  if (isRunning.value) return 'Enter queues the draft while a run is active · Shift+Enter for newline'
  return 'Enter to send · Shift+Enter for newline'
})

const queuedDraftCount = computed(() => queuedDrafts.value.length)

const nextQueuedDraft = computed(() => queuedDrafts.value[0] || null)

const queuedDraftLabel = computed(() => {
  if (!nextQueuedDraft.value) return ''

  const modeLabel = nextQueuedDraft.value.mode === 'steer'
    ? 'Steering next'
    : nextQueuedDraft.value.mode === 'stop-and-send'
      ? 'Send after stop'
      : 'Queued next'

  if (queuedDraftCount.value === 1) return modeLabel
  return `${modeLabel} · ${queuedDraftCount.value} total`
})

const queuedDraftSummary = computed(() => {
  if (!nextQueuedDraft.value) return ''

  if (queuedDraftCount.value === 1) return nextQueuedDraft.value.text
  return `${nextQueuedDraft.value.text} +${queuedDraftCount.value - 1} more`
})

const contextUsagePercent = computed(() => getContextUsagePercent(messages.value, chatContextSummary.value))

const contextMeterTone = computed(() => {
  if (contextUsagePercent.value >= 100) return 'full'
  if (contextUsagePercent.value >= 80) return 'warning'
  return ''
})

const contextMeterSummary = computed(() => {
  if (chatContextSummary.value.text) {
    const compactedLabel = chatContextSummary.value.compactedCount === 1 ? '1 summary block' : `${chatContextSummary.value.compactedCount} summary blocks`
    return `Auto-summary active · ${compactedLabel} · keeps the latest ${CHAT_CONTEXT_KEEP_RECENT_USER_TURNS} user turns live.`
  }

  if (contextUsagePercent.value >= 100) {
    return 'Older context will be summarized before the next model call.'
  }

  return 'Older context will be summarized automatically at 100% to keep prompts compact.'
})

const emptyStateDescription = computed(() => {
  return `AI coding agent powered by ${activeModelLabel}.`
})

const githubStatusLabel = computed(() => {
  if (githubStatus.value.loading) return 'Checking GitHub status'
  if (!workingDir.value) return 'No working directory'
  if (!githubStatus.value.available) return 'gh CLI not available'
  if (!githubStatus.value.authenticated) return 'GitHub auth required'
  if (!githubStatus.value.repo) return 'No git repository'
  if (!githubStatus.value.repoSlug) return 'GitHub remote missing'
  return githubStatus.value.account
    ? `Connected as ${githubStatus.value.account}`
    : 'GitHub ready'
})

const githubStatusDetail = computed(() => {
  if (githubStatus.value.loading) return 'Checking gh authentication and origin remote...'
  if (!workingDir.value) return 'Select a repository folder to enable GitHub workflows.'
  if (githubStatusLoginAvailable.value) return 'Click this card or use the button below to launch GitHub login in a separate window.'
  if (githubStatus.value.repoSlug) return githubStatus.value.message || `Origin remote: ${githubStatus.value.repoSlug}`
  return githubStatus.value.repoMessage || githubStatus.value.authMessage || githubStatus.value.message
})

const githubStatusTone = computed(() => ({
  ready: githubStatus.value.available && githubStatus.value.authenticated && Boolean(githubStatus.value.repoSlug),
  warning: githubStatus.value.available && (!githubStatus.value.authenticated || !githubStatus.value.repoSlug),
}))

const githubStatusLoginAvailable = computed(() => {
  return githubStatus.value.available && !githubStatus.value.authenticated
})

const previewLanguage = computed(() => detectPreviewLanguage(previewState.value.path))

const highlightedPreviewContent = computed(() => {
  const content = previewState.value.content || ''
  if (!content) return ''

  try {
    if (previewLanguage.value && hljs.getLanguage(previewLanguage.value)) {
      return hljs.highlight(content, { language: previewLanguage.value, ignoreIllegals: true }).value
    }

    return hljs.highlightAuto(content).value
  } catch {
    return escapeHtml(content)
  }
})

// ─── Methods ─────────────────────────────────────────────────────────────────

function saveApiKey() {
  localStorage.setItem('bliss_openrouter_api_key', openRouterApiKey.value)
  localStorage.removeItem('bliss_api_key')
}

function saveActiveApiKey() {
  localStorage.setItem(activeProvider.value.storageKey, selectedApiKey.value)
  if (provider.value === 'openrouter') {
    localStorage.removeItem('bliss_api_key')
  }
}

function saveIterationBudget() {
  iterationBudget.value = normalizeIterationBudget(iterationBudget.value, 15)
  localStorage.setItem(ITERATION_BUDGET_STORAGE_KEY, String(iterationBudget.value))
}

function adjustIterationBudget(delta) {
  iterationBudget.value = normalizeIterationBudget(Number(iterationBudget.value) + delta, iterationBudget.value)
  saveIterationBudget()
}

function selectProvider(nextProvider) {
  provider.value = nextProvider
  localStorage.setItem('bliss_provider', nextProvider)
}

function openSettings(tab = 'provider') {
  settingsTab.value = tab
  settingsOpen.value = true
}

function closeSettings() {
  settingsOpen.value = false
}

async function pickFolder() {
  const folder = await window.electronAPI.openFolder()
  if (folder) {
    workingDir.value = folder
    localStorage.setItem('bliss_working_dir', folder)
    await refreshGitHubStatus()
  }
}

async function refreshGitHubStatus() {
  if (!window.electronAPI?.getGitHubStatus) return

  if (!workingDir.value) {
    githubStatus.value = {
      loading: false,
      available: false,
      authenticated: false,
      account: '',
      repo: false,
      repoSlug: '',
      branch: '',
      authMessage: '',
      repoMessage: '',
      message: 'Select a working directory to inspect GitHub status.',
    }
    return
  }

  githubStatus.value = {
    ...githubStatus.value,
    loading: true,
  }

  try {
    const result = await window.electronAPI.getGitHubStatus({ workingDir: workingDir.value })
    githubStatus.value = {
      loading: false,
      available: Boolean(result?.available),
      authenticated: Boolean(result?.authenticated),
      account: result?.account || '',
      repo: Boolean(result?.repo),
      repoSlug: result?.repoSlug || '',
      branch: result?.branch || '',
      authMessage: result?.authMessage || '',
      repoMessage: result?.repoMessage || '',
      message: result?.message || 'GitHub status unavailable.',
    }
  } catch (error) {
    githubStatus.value = {
      loading: false,
      available: false,
      authenticated: false,
      account: '',
      repo: false,
      repoSlug: '',
      branch: '',
      authMessage: '',
      repoMessage: '',
      message: error.message || 'GitHub status unavailable.',
    }
  }
}

function stopGitHubStatusPolling() {
}

async function handleGitHubStatusClick() {
  if (!githubStatusLoginAvailable.value || !window.electronAPI?.startGitHubLogin) return

  const result = await window.electronAPI.startGitHubLogin({ workingDir: workingDir.value })
  if (!result?.success) {
    githubStatus.value = {
      ...githubStatus.value,
      message: result?.error || 'Failed to launch GitHub login.',
    }
    return
  }

  githubStatus.value = {
    ...githubStatus.value,
    loading: false,
    message: result.message,
  }
}

function buildActiveChatSnapshot() {
  const snapshotTitle = activeChatTitleManuallySet.value
    ? normalizeChatTitle(activeChatTitle.value)
    : getChatTitleFromState(displayMessages.value, messages.value)

  return createEmptyChatSession({
    id: activeChatId.value,
    title: snapshotTitle,
    titleManuallySet: activeChatTitleManuallySet.value,
    workingDir: workingDir.value,
    input: input.value,
    messages: toIpcSafe(messages.value),
    displayMessages: toIpcSafe(displayMessages.value),
    modelEvents: toIpcSafe(modelEvents.value),
    validationRuns: toIpcSafe(validationRuns.value),
    changeEvents: toIpcSafe(changeEvents.value),
    iterationStateByTurn: toIpcSafe(iterationStateByTurn.value),
    workflowExpandedByTurn: toIpcSafe(workflowExpandedByTurn.value),
    stoppedTurns: toIpcSafe(stoppedTurns.value),
    latestWorkflowTurnId: latestWorkflowTurnId.value,
    approvalPolicy: toIpcSafe(approvalPolicy.value),
    conversationModelProvider: conversationModelProvider.value,
    conversationModelLabel: conversationModelLabel.value,
    conversationModelMeta: conversationModelMeta.value,
    providerRuntimeState: toIpcSafe(providerRuntimeState.value),
    contextSummary: toIpcSafe(chatContextSummary.value),
    contextSummaryExpanded: contextSummaryExpanded.value,
    queuedDrafts: toIpcSafe(queuedDrafts.value),
    updatedAt: Date.now(),
  })
}

function syncActiveChatSession() {
  if (isApplyingChatState.value || !activeChatId.value) return

  const snapshot = buildActiveChatSnapshot()
  chatSessions.value = chatSessions.value.map((chat) => chat.id === activeChatId.value ? snapshot : chat)
}

function applyChatSession(session) {
  isApplyingChatState.value = true
  activeChatTitle.value = session.title || 'New chat'
  activeChatTitleManuallySet.value = Boolean(session.titleManuallySet)
  workingDir.value = session.workingDir || ''
  input.value = session.input || ''
  messages.value = session.messages || []
  displayMessages.value = session.displayMessages || []
  modelEvents.value = session.modelEvents || []
  validationRuns.value = session.validationRuns || []
  changeEvents.value = session.changeEvents || []
  iterationStateByTurn.value = session.iterationStateByTurn || {}
  workflowExpandedByTurn.value = session.workflowExpandedByTurn || {}
  stoppedTurns.value = session.stoppedTurns || {}
  latestWorkflowTurnId.value = session.latestWorkflowTurnId || null
  activeRunId.value = ''
  isCancelling.value = false
  activeToolState.value = { tool: '', cancelling: false }
  approvalPolicy.value = session.approvalPolicy || { allowAll: false, allowedTools: {} }
  conversationModelProvider.value = session.conversationModelProvider || ''
  conversationModelLabel.value = session.conversationModelLabel || ''
  conversationModelMeta.value = session.conversationModelMeta || ''
  providerRuntimeState.value = session.providerRuntimeState || {}
  chatContextSummary.value = normalizeContextSummary(session.contextSummary)
  contextSummaryExpanded.value = Boolean(session.contextSummaryExpanded)
  queuedDrafts.value = session.queuedDrafts || []
  clearPreview()

  nextTick(() => {
    autoResize()
    isApplyingChatState.value = false
  })
}

async function selectChat(chatId) {
  if (!chatId || chatId === activeChatId.value || isRunning.value) return

  cancelChatRename()
  syncActiveChatSession()
  const nextChat = chatSessions.value.find((chat) => chat.id === chatId)
  if (!nextChat) return

  activeChatId.value = chatId
  applyChatSession(nextChat)
  await refreshGitHubStatus()
  nextTick(() => inputEl.value?.focus())
}

function getChatSessionMeta(chat) {
  const directoryName = (chat.workingDir || '').split(/[\\/]/).filter(Boolean).pop() || 'No folder'
  const userCount = Array.isArray(chat.displayMessages)
    ? chat.displayMessages.filter((message) => message?.type === 'user').length
    : 0

  return userCount ? `${directoryName} · ${userCount} turn${userCount === 1 ? '' : 's'}` : directoryName
}

function newChat() {
  if (isRunning.value) return

  cancelChatRename()
  syncActiveChatSession()

  const session = createEmptyChatSession({
    workingDir: workingDir.value,
  })

  chatSessions.value = [session, ...chatSessions.value]
  activeChatId.value = session.id
  applyChatSession(session)
  refreshGitHubStatus()
  nextTick(() => inputEl.value?.focus())
}

function startChatRename(chat) {
  if (!chat?.id || isRunning.value) return

  editingChatId.value = chat.id
  editingChatTitle.value = chat.title || ''

  nextTick(() => {
    chatRenameInputEl.value?.focus()
    chatRenameInputEl.value?.select()
  })
}

function cancelChatRename() {
  editingChatId.value = ''
  editingChatTitle.value = ''
}

function commitChatRename(chatId) {
  if (!chatId) return

  const nextTitle = normalizeChatTitle(editingChatTitle.value)
  chatSessions.value = chatSessions.value.map((chat) => {
    if (chat.id !== chatId) return chat
    return createEmptyChatSession({
      ...chat,
      title: nextTitle,
      titleManuallySet: true,
      updatedAt: Date.now(),
    })
  })

  if (chatId === activeChatId.value) {
    activeChatTitle.value = nextTitle
    activeChatTitleManuallySet.value = true
  }

  cancelChatRename()
}

async function deleteChat(chatId) {
  if (!chatId || isRunning.value) return

  const chatIndex = chatSessions.value.findIndex((chat) => chat.id === chatId)
  if (chatIndex === -1) return

  const chat = chatSessions.value[chatIndex]
  const confirmed = window.confirm(`Delete chat "${chat.title}"? This removes its local conversation history.`)
  if (!confirmed) return

  cancelChatRename()

  if (chatSessions.value.length === 1) {
    const replacement = createEmptyChatSession({
      workingDir: workingDir.value,
    })

    chatSessions.value = [replacement]
    activeChatId.value = replacement.id
    applyChatSession(replacement)
    await refreshGitHubStatus()
    nextTick(() => inputEl.value?.focus())
    return
  }

  const remainingChats = chatSessions.value.filter((entry) => entry.id !== chatId)
  chatSessions.value = remainingChats

  if (chatId !== activeChatId.value) return

  const nextChat = remainingChats[chatIndex] || remainingChats[chatIndex - 1] || remainingChats[0]
  if (!nextChat) return

  activeChatId.value = nextChat.id
  applyChatSession(nextChat)
  await refreshGitHubStatus()
  nextTick(() => inputEl.value?.focus())
}

function clearApprovalPolicy() {
  approvalPolicy.value = { allowAll: false, allowedTools: {} }
}

function getTurnModelEvents(turnId) {
  return modelEvents.value.filter((entry) => entry.turnId === turnId)
}

function shouldShowWorkflowInline(message, index) {
  return message?.type === 'tool'
    && index === getLastToolMessageIndexForTurn(message.turnId)
    && getTurnWorkflowHasContent(message.turnId)
}

function isWorkflowExpanded(turnId) {
  return Boolean(workflowExpandedByTurn.value[turnId])
}

function toggleWorkflow(turnId) {
  workflowExpandedByTurn.value = {
    ...workflowExpandedByTurn.value,
    [turnId]: !isWorkflowExpanded(turnId),
  }
}

function isTurnStopped(turnId) {
  return Boolean(stoppedTurns.value[turnId])
}

function getWorkflowStateLabel(turnId) {
  if (latestWorkflowTurnId.value === turnId && isCancelling.value) return 'Stopping'
  if (latestWorkflowTurnId.value === turnId && isRunning.value) return 'Live'
  if (isTurnStopped(turnId)) return 'Stopped'
  return 'Collapsed'
}

function getTurnValidationRuns(turnId) {
  return validationRuns.value.filter((entry) => entry.turnId === turnId)
}

function getTurnIterationState(turnId) {
  return iterationStateByTurn.value[turnId] || null
}

function getWorkflowIterationLabel(turnId) {
  const state = getTurnIterationState(turnId)
  if (!state?.max) return ''
  return `${state.current}/${state.max}`
}

function getTurnChangeEvents(turnId) {
  return changeEvents.value.filter((entry) => entry.turnId === turnId)
}

function getTurnWorkflowSteps(turnId) {
  return displayMessages.value
    .filter((message) => message.type === 'tool' && message.turnId === turnId)
    .slice(-8)
    .reverse()
    .map((message, index) => {
      const status = !message.result ? 'running' : message.result.toolCancelled ? 'neutral' : message.result.success ? 'ok' : 'fail'
      return {
        id: `${turnId}-${message.tool}-${index}-${formatToolArgs(message.args)}`,
        label: message.tool.replace(/_/g, ' '),
        scope: formatToolArgs(message.args),
        summary: message.result ? summarizeActivityResult(message.result) : message.progress?.message || 'Running...',
        status,
      }
    })
}

function getTurnLastAssistantSummary(turnId) {
  const latestAssistant = [...displayMessages.value]
    .reverse()
    .find((message) => message.type === 'assistant' && message.turnId === turnId && normalizeDisplayText(message.content).trim())

  if (!latestAssistant) return ''

  return normalizeDisplayText(latestAssistant.content)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320)
}

function getTurnWorkflowDiffText(turnId) {
  const lastDiffMessage = [...displayMessages.value]
    .reverse()
    .find((message) => message.type === 'tool' && message.turnId === turnId && message.tool === 'git_diff' && message.result)

  const result = lastDiffMessage?.result
  if (!result) return ''
  if (!result.success) return result.error || result.stderr || ''
  return result.stdout || result.message || ''
}

function getTurnWorkflowHasContent(turnId) {
  return Boolean(
    getTurnIterationState(turnId)?.max ||
    getTurnModelEvents(turnId).length ||
    getTurnWorkflowSteps(turnId).length ||
    getTurnValidationRuns(turnId).length ||
    getTurnChangeEvents(turnId).length ||
    getTurnWorkflowDiffText(turnId) ||
    getTurnLastAssistantSummary(turnId) ||
    isTurnStopped(turnId)
  )
}

function getWorkflowSummaryLine(turnId) {
  const parts = []
  const iterationLabel = getWorkflowIterationLabel(turnId)
  if (iterationLabel) parts.push(`loop ${iterationLabel}`)
  if (isTurnStopped(turnId)) parts.push('stopped')
  if (getTurnModelEvents(turnId).length) parts.push('model updated')
  if (getTurnModelEvents(turnId).some((entry) => entry.kind === 'finish')) parts.push('finish reason captured')
  if (getTurnWorkflowSteps(turnId).length) parts.push('plan updated')
  if (getTurnValidationRuns(turnId).length) parts.push('validation updated')
  if (getTurnChangeEvents(turnId).length) parts.push('changes updated')
  if (getTurnWorkflowDiffText(turnId)) parts.push('diff ready')
  return parts.join(' · ') || 'No workflow details yet'
}

function getWorkflowLines(turnId) {
  const entries = []
  const iterationState = getTurnIterationState(turnId)
  const turnModelEvents = getTurnModelEvents(turnId)
  const workflowSteps = getTurnWorkflowSteps(turnId)
  const validationEntries = getTurnValidationRuns(turnId)
  const changeEntries = getTurnChangeEvents(turnId)
  const workflowDiffText = getTurnWorkflowDiffText(turnId)
  const workflowDiffTruncated = workflowDiffText.split(/\r?\n/).length > 120
  const lastAssistantSummary = getTurnLastAssistantSummary(turnId)

  if (isTurnStopped(turnId)) {
    entries.push({
      id: `stopped-${turnId}`,
      label: 'Run',
      text: 'Execution was stopped before completion.',
      tone: 'neutral',
    })
  }

  if (iterationState?.max) {
    entries.push({
      id: `iteration-${turnId}`,
      label: 'Loop',
      text: `Iteration ${iterationState.current}/${iterationState.max}${iterationState.intent ? ` · ${iterationState.intent}` : ''}`,
      tone: 'neutral',
    })
  }

  turnModelEvents.slice(0, 2).forEach((entry) => {
    entries.push({
      id: `model-${entry.id}`,
      label: 'Model',
      text: entry.kind === 'finish'
        ? `${entry.finishReason}${entry.toolCallCount ? ` · ${entry.toolCallCount} tool call${entry.toolCallCount === 1 ? '' : 's'}` : ''}${entry.hasContent ? ' · content present' : ''}`
        : `${entry.providerLabel} · ${entry.model}`,
      tone: entry.kind === 'finish' ? 'fail' : 'neutral',
    })
  })

  workflowSteps.slice(0, 5).forEach((step) => {
    entries.push({
      id: `step-${step.id}`,
      label: 'Plan',
      text: `${step.label}${step.scope ? ` · ${step.scope}` : ''} · ${step.summary}`,
      tone: step.status,
    })
  })

  validationEntries.slice(0, 2).forEach((entry) => {
    entries.push({
      id: `validation-${entry.id}`,
      label: 'Validation',
      text: `${entry.label} · ${entry.summary}`,
      tone: entry.success ? 'ok' : 'fail',
    })
  })

  changeEntries.slice(0, 2).forEach((entry) => {
    entries.push({
      id: `change-${entry.id}`,
      label: 'Changes',
      text: `${entry.label} · ${entry.summary}`,
      tone: entry.success ? 'ok' : 'neutral',
    })
  })

  if (workflowDiffText) {
    entries.push({
      id: `diff-${turnId}`,
      label: 'Diff',
      text: workflowDiffTruncated ? 'Latest diff ready to inspect.' : 'Latest diff captured.',
      tone: 'neutral',
    })
  }

  if (lastAssistantSummary) {
    entries.push({
      id: `assistant-summary-${turnId}`,
      label: 'Reply',
      text: lastAssistantSummary,
      tone: 'neutral',
    })
  }

  return entries.slice(0, 8)
}

function getLastToolMessageIndexForTurn(turnId) {
  for (let index = displayMessages.value.length - 1; index >= 0; index--) {
    const message = displayMessages.value[index]
    if (message?.type === 'tool' && message.turnId === turnId) return index
  }
  return -1
}

function useSuggestion(s) {
  input.value = s
  nextTick(() => inputEl.value?.focus())
}

function handleWindowKeydown(event) {
  if (event.key === 'Escape' && settingsOpen.value) {
    closeSettings()
  }
}

function handleWindowFocus() {
  refreshGitHubStatus()
}

function clearPreview() {
  previewOpen.value = false
  previewState.value = { path: '', content: '', startLine: 0, endLine: 0, focusLine: null, totalLines: 0 }
  previewError.value = ''
  previewCopyState.value = ''
}

function getPreviewWidthBounds() {
  const viewportWidth = Math.max(window.innerWidth || 1280, 900)
  return {
    min: 280,
    max: Math.max(720, Math.floor(viewportWidth * 0.72)),
  }
}

function clampPreviewWidth(width) {
  const { min, max } = getPreviewWidthBounds()
  return Math.min(max, Math.max(min, Math.floor(width)))
}

function getDefaultPreviewWidth() {
  return clampPreviewWidth((window.innerWidth || 1280) * 0.5)
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function detectPreviewLanguage(filePath) {
  const extension = (filePath.split('.').pop() || '').toLowerCase()
  const byExtension = {
    js: 'javascript',
    cjs: 'javascript',
    mjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    vue: 'xml',
    html: 'xml',
    xml: 'xml',
    css: 'css',
    scss: 'scss',
    json: 'json',
    md: 'markdown',
    py: 'python',
    cs: 'csharp',
    java: 'java',
    kt: 'kotlin',
    go: 'go',
    rs: 'rust',
    php: 'php',
    rb: 'ruby',
    sh: 'bash',
    ps1: 'powershell',
    yml: 'yaml',
    yaml: 'yaml',
    sql: 'sql',
    dockerfile: 'dockerfile',
  }

  const fileName = filePath.split('/').pop()?.toLowerCase() || ''
  if (fileName === 'dockerfile') return 'dockerfile'
  return byExtension[extension] || ''
}

async function copyPreviewContent() {
  if (!previewState.value.content) return

  try {
    await navigator.clipboard.writeText(previewState.value.content)
    previewCopyState.value = 'Copied'
  } catch {
    previewCopyState.value = 'Copy failed'
  }

  window.setTimeout(() => {
    previewCopyState.value = ''
  }, 1500)
}

function summarizeActivityResult(result) {
  if (!result) return ''
  if (result.toolCancelled) return result.message || 'Tool cancelled'
  if (!result.success) return result.error || result.stderr || 'Command failed'
  if (result.stdout) return result.stdout.trim().slice(0, 160)
  if (result.message) return result.message
  return 'Completed'
}

function recordActivity(listRef, tool, result, label, turnId) {
  listRef.value.unshift({
    id: `${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    turnId,
    label,
    success: Boolean(result?.success),
    summary: summarizeActivityResult(result),
  })
  listRef.value = listRef.value.slice(0, 24)
}

function recordModelSelection(providerId, model, turnId) {
  const providerOption = getProviderOptionById(providerId)
  const providerLabel = providerOption?.label || providerId

  conversationModelProvider.value = providerId
  conversationModelLabel.value = model
  conversationModelMeta.value = providerOption
    ? `Active in this chat · ${providerOption.modelMeta}`
    : 'Active in this chat'

  const lastTurnEvent = modelEvents.value[0]
  if (lastTurnEvent?.turnId === turnId && lastTurnEvent?.providerId === providerId && lastTurnEvent?.model === model) {
    return
  }

  modelEvents.value.unshift({
    id: `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    turnId,
    providerId,
    providerLabel,
    model,
  })
  modelEvents.value = modelEvents.value.slice(0, 24)
}

function recordModelResponse(update, turnId) {
  const finishReason = String(update?.finishReason || '').trim()
  if (!finishReason || finishReason === 'stop' || finishReason === 'tool_calls') return

  const lastTurnFinishEvent = modelEvents.value[0]
  if (
    lastTurnFinishEvent?.turnId === turnId
    && lastTurnFinishEvent?.kind === 'finish'
    && lastTurnFinishEvent?.finishReason === finishReason
  ) {
    return
  }

  modelEvents.value.unshift({
    id: `model-finish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    turnId,
    kind: 'finish',
    finishReason,
    toolCallCount: Number(update?.toolCallCount) || 0,
    hasContent: Boolean(update?.hasContent),
  })
  modelEvents.value = modelEvents.value.slice(0, 24)
}

function recordFallbackStatus(update) {
  if (!update?.provider) return

  let summary = ''
  let tone = 'idle'

  if (update.stage === 'trying') {
    summary = `Trying ${update.model} · ${update.attempt}/${update.total}`
    tone = 'pending'
  } else if (update.stage === 'failed') {
    summary = `Failed ${update.model} · ${update.attempt}/${update.total}`
    tone = 'warning'
  } else if (update.stage === 'selected') {
    summary = update.usedFallback
      ? `Using fallback ${update.model} · ${update.attempt}/${update.total}`
      : `Primary model ${update.model}`
    tone = update.usedFallback ? 'ready' : 'idle'
  } else if (update.stage === 'exhausted') {
    summary = `Fallback exhausted · ${update.total || 0} attempts`
    tone = 'error'
  }

  providerRuntimeState.value = {
    ...providerRuntimeState.value,
    [update.provider]: {
      summary,
      tone,
      stage: update.stage,
      model: update.model || '',
      attempt: update.attempt || 0,
      total: update.total || 0,
    },
  }
}

function getProviderRuntimeSummary(providerId) {
  return providerRuntimeState.value[providerId]?.summary || 'Idle'
}

function getProviderRuntimeTone(providerId) {
  return providerRuntimeState.value[providerId]?.tone || 'idle'
}

function handlePreviewResize(event) {
  const nextWidth = window.innerWidth - event.clientX
  previewWidth.value = clampPreviewWidth(nextWidth)
}

function stopPreviewResize() {
  window.removeEventListener('mousemove', handlePreviewResize)
  window.removeEventListener('mouseup', stopPreviewResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

function startPreviewResize() {
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', handlePreviewResize)
  window.addEventListener('mouseup', stopPreviewResize)
}

function toIpcSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, currentValue) => {
    if (typeof currentValue === 'bigint') return currentValue.toString()
    if (typeof currentValue === 'function' || typeof currentValue === 'symbol' || typeof currentValue === 'undefined') return null
    return currentValue
  }))
}

function createTurnId() {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function buildUserMessageForMode(userText, mode) {
  if (mode === 'steer') {
    return `Continue the current task using this steering instruction:\n${userText}`
  }

  return userText
}

function addQueuedDraft(mode, text, { prioritize = false } = {}) {
  const entry = {
    id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mode,
    text,
  }

  queuedDrafts.value = prioritize
    ? [entry, ...queuedDrafts.value]
    : [...queuedDrafts.value, entry]
}

function queueDraft(mode = 'queue') {
  if (!canQueueDraft.value) return

  addQueuedDraft(mode, draftText.value)
  input.value = ''
  autoResize()
  nextTick(() => inputEl.value?.focus())
}

function clearQueuedDrafts() {
  queuedDrafts.value = []
}

function removeQueuedDraft(draftId) {
  queuedDrafts.value = queuedDrafts.value.filter((draft) => draft.id !== draftId)
}

function moveQueuedDraft(draftId, offset) {
  const currentIndex = queuedDrafts.value.findIndex((draft) => draft.id === draftId)
  if (currentIndex === -1) return

  const nextIndex = currentIndex + offset
  if (nextIndex < 0 || nextIndex >= queuedDrafts.value.length) return

  const reorderedDrafts = [...queuedDrafts.value]
  const [draft] = reorderedDrafts.splice(currentIndex, 1)
  reorderedDrafts.splice(nextIndex, 0, draft)
  queuedDrafts.value = reorderedDrafts
}

async function stopRun() {
  if (!activeRunId.value || !window.electronAPI?.cancelAgentRun) return

  isCancelling.value = true

  try {
    await window.electronAPI.cancelAgentRun({ runId: activeRunId.value })
  } catch {
    isCancelling.value = false
  }
}

async function stopActiveTool() {
  if (!activeRunId.value || !activeToolState.value.tool || !window.electronAPI?.cancelAgentTool) return

  activeToolState.value = {
    ...activeToolState.value,
    cancelling: true,
  }

  try {
    const result = await window.electronAPI.cancelAgentTool({ runId: activeRunId.value })
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to stop active tool')
    }
  } catch {
    activeToolState.value = {
      ...activeToolState.value,
      cancelling: false,
    }
  }
}

async function stopAndSendDraft() {
  if (!canQueueDraft.value) return

  addQueuedDraft('stop-and-send', draftText.value, { prioritize: true })
  input.value = ''
  autoResize()
  await stopRun()
}

function handleComposerSubmit() {
  if (isRunning.value) {
    queueDraft('queue')
    return
  }

  send()
}

async function runTurn(userText, mode = 'send', options = {}) {
  if (!userText.trim() || !selectedApiKey.value.trim()) return

  if (!window.electronAPI?.runAgent) {
    displayMessages.value.push({
      type: 'assistant',
      content: '**Error:** Electron bridge is unavailable. Open the app through Electron, not only the Vite page.'
    })
    await scrollToBottom()
    return
  }

  const turnId = createTurnId()
  const runId = `run-${turnId}`
  const outgoingUserText = buildUserMessageForMode(userText, mode)
  const showUserMessage = options.displayUserMessage !== false
  const seedHistory = Array.isArray(options.historyOverride) ? options.historyOverride : messages.value
  const compactedHistoryState = compactChatContext(seedHistory, chatContextSummary.value, outgoingUserText)
  const historyForRun = buildHistoryForRun(compactedHistoryState.history, compactedHistoryState.summary)
  let continuationRequest = null

  if (compactedHistoryState.compacted) {
    messages.value = compactedHistoryState.history
    chatContextSummary.value = compactedHistoryState.summary
  }

  stoppedTurns.value = {
    ...stoppedTurns.value,
    [turnId]: false,
  }
  activeRunId.value = runId
  latestWorkflowTurnId.value = turnId
  if (showUserMessage) {
    displayMessages.value.push({ type: 'user', content: userText, turnId })
  }
  setThinkingIndicator(turnId, true)
  workflowExpandedByTurn.value = {
    ...workflowExpandedByTurn.value,
    [turnId]: true,
  }
  await scrollToBottom()

  isRunning.value = true
  isCancelling.value = false
  let cleanup = () => {}

  try {
    if (window.electronAPI.onAgentUpdate) {
      cleanup = window.electronAPI.onAgentUpdate((update) => {
        if (update?.runId && update.runId !== runId) return

        if (update.type === 'thinking') {
          setThinkingIndicator(turnId, true, update.text || 'Thinking...')
        } else if (update.type === 'fallback_status') {
          setThinkingIndicator(turnId, true)
          recordFallbackStatus(update)
        } else if (update.type === 'active_tool') {
          activeToolState.value = update.stage === 'start'
            ? { tool: update.tool || '', cancelling: false }
            : { tool: '', cancelling: false }
        } else if (update.type === 'model_selected') {
          setThinkingIndicator(turnId, true)
          recordModelSelection(update.provider, update.model, turnId)
        } else if (update.type === 'model_response') {
          setThinkingIndicator(turnId, true)
          recordModelResponse(update, turnId)
        } else if (update.type === 'iteration') {
          setThinkingIndicator(turnId, true)
          iterationStateByTurn.value = {
            ...iterationStateByTurn.value,
            [turnId]: {
              current: Number(update.current) || 0,
              max: Number(update.max) || 0,
              intent: update.intent || '',
            },
          }
        } else if (update.type === 'assistant_partial') {
          setThinkingIndicator(turnId, false)
          upsertAssistantMessage(turnId, update.content, { isStreaming: true })
        } else if (update.type === 'approval_required') {
          setThinkingIndicator(turnId, false)
          upsertApprovalMessage(turnId, update)
        } else if (update.type === 'approval_auto_approved') {
          setThinkingIndicator(turnId, false)
          const approvalMessage = upsertApprovalMessage(turnId, update)
          approvalMessage.resolved = true
          approvalMessage.decision = update.decision || 'approved'
          approvalMessage.submitting = false
        } else if (update.type === 'tool') {
          setThinkingIndicator(turnId, false)
          clearStreamingAssistantMessageForTurn(turnId)
          displayMessages.value.push({ type: 'tool', tool: update.tool, args: update.args, result: null, progress: null, turnId, showAllItems: false })
        } else if (update.type === 'tool_progress') {
          setThinkingIndicator(turnId, false)
          const toolMsg = [...displayMessages.value].reverse().find(m => m.type === 'tool' && m.turnId === turnId && m.tool === update.tool && !m.result)
          if (toolMsg) toolMsg.progress = update.progress
        } else if (update.type === 'tool_result') {
          setThinkingIndicator(turnId, false)
          // Update last tool call with result
          const toolMsg = [...displayMessages.value].reverse().find(m => m.type === 'tool' && m.turnId === turnId && m.tool === update.tool && !m.result)
          if (toolMsg) {
            toolMsg.result = update.result
            toolMsg.progress = null
          }

          if (['run_build', 'run_test', 'run_lint'].includes(update.tool)) {
            recordActivity(validationRuns, update.tool, update.result, update.tool.replace('run_', '').toUpperCase(), turnId)
          }

          if (['git_status', 'git_diff', 'git_create_branch', 'git_add', 'git_commit'].includes(update.tool)) {
            recordActivity(changeEvents, update.tool, update.result, update.tool.replace(/_/g, ' '), turnId)
          }
        }
        scrollToBottom()
      })
    }

    const payload = toIpcSafe({
      runId,
      chatId: activeChatId.value,
      userMessage: outgoingUserText,
      history: historyForRun,
      apiKey: selectedApiKey.value,
      provider: provider.value,
      workingDir: workingDir.value,
      approvalPolicy: approvalPolicy.value,
      iterationBudget: iterationBudget.value,
    })

    const result = await window.electronAPI.runAgent(payload)

    setThinkingIndicator(turnId, false)

    if (result.success) {
      resolveApprovalMessagesForTurn(turnId, 'approved')
      upsertAssistantMessage(turnId, result.reply, { isStreaming: false })
      const nextHistoryState = compactChatContext(result.messages, chatContextSummary.value)
      messages.value = nextHistoryState.history
      chatContextSummary.value = nextHistoryState.summary
    } else if (result.continuationRequired) {
      resolveApprovalMessagesForTurn(turnId, 'approved')
      if (Array.isArray(result.messages)) {
        const nextHistoryState = compactChatContext(result.messages, chatContextSummary.value)
        messages.value = nextHistoryState.history
        chatContextSummary.value = nextHistoryState.summary
      }
      continuationRequest = {
        prompt: result.continuationPrompt || 'Continue the previous task from the current state until it is fully complete.',
        budget: normalizeIterationBudget(result.continuationBudget, iterationBudget.value),
      }
    } else if (result.cancelled) {
      stoppedTurns.value = {
        ...stoppedTurns.value,
        [turnId]: true,
      }
      resolveApprovalMessagesForTurn(turnId, 'cancelled')
      if (result.partialReply) {
        upsertAssistantMessage(turnId, result.partialReply, { isStreaming: false })
        if (Array.isArray(result.messages)) {
          const nextHistoryState = compactChatContext(result.messages, chatContextSummary.value)
          messages.value = nextHistoryState.history
          chatContextSummary.value = nextHistoryState.summary
        }
      } else if (!queuedDraftCount.value) {
        displayMessages.value.push({
          type: 'assistant',
          content: 'Stopped.',
          turnId,
        })
      }
    } else {
      resolveApprovalMessagesForTurn(turnId, 'cancelled')
      displayMessages.value.push({
        type: 'assistant',
        content: `**Error:** ${result.error}`,
        turnId,
      })
    }
  } catch (e) {
    resolveApprovalMessagesForTurn(turnId, 'cancelled')
    displayMessages.value.push({ type: 'assistant', content: `**Error:** ${e.message}`, turnId })
  } finally {
    cleanup()
    isRunning.value = false
    isCancelling.value = false
    activeToolState.value = { tool: '', cancelling: false }
    activeRunId.value = ''
    workflowExpandedByTurn.value = {
      ...workflowExpandedByTurn.value,
      [turnId]: false,
    }
    await scrollToBottom()
    nextTick(() => inputEl.value?.focus())

    if (continuationRequest) {
      const approved = window.confirm(`The iteration budget was reached (${iterationBudget.value} loops). Allow Bliss Agent to continue with another ${continuationRequest.budget}-loop block?`)
      if (approved) {
        iterationBudget.value = normalizeIterationBudget(continuationRequest.budget, iterationBudget.value)
        saveIterationBudget()
        await runTurn(continuationRequest.prompt, 'steer', {
          displayUserMessage: false,
          historyOverride: messages.value,
        })
        return
      }

      displayMessages.value.push({
        type: 'assistant',
        content: `Paused after reaching the configured iteration budget (${iterationBudget.value}/${iterationBudget.value}).`,
        turnId,
      })
      await scrollToBottom()
      return
    }

    if (queuedDraftCount.value) {
      const [nextDraft, ...remainingDrafts] = queuedDrafts.value
      queuedDrafts.value = remainingDrafts
      await runTurn(nextDraft.text, nextDraft.mode === 'steer' ? 'steer' : 'send')
    }
  }
}

async function send() {
  if (!canSend.value) return

  const userText = draftText.value
  input.value = ''
  autoResize()
  await runTurn(userText)
}

async function scrollToBottom() {
  await nextTick()
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
}

function autoResize() {
  nextTick(() => {
    if (inputEl.value) {
      inputEl.value.style.height = 'auto'
      inputEl.value.style.height = Math.min(inputEl.value.scrollHeight, 160) + 'px'
    }
  })
}

function getToolIcon(tool) {
  const map = {
    find_files: '⌕',
    search_text: '≣',
    read_file: '◎',
    read_file_range: '◱',
    apply_patch: '✎',
    write_file: '◉',
    list_directory: '◫',
    git_status: '⑂',
    git_diff: 'Δ',
    git_create_branch: '⑃',
    git_add: '⊕',
    git_commit: '✓',
    github_auth_status: '⌘',
    github_repo_info: '⌂',
    github_issue_list: '⋯',
    github_issue_view: '◌',
    github_issue_create: '⊕',
    github_issue_edit: '≡',
    github_issue_close: '⊘',
    github_issue_reopen: '↺',
    github_issue_comment: '✎',
    github_pr_list: '⋮',
    github_pr_view: '◍',
    github_pr_checks: '☰',
    github_pr_review_comments: '✦',
    github_pr_review_threads: '⟟',
    github_pr_edit: '≣',
    github_pr_review_submit: '☑',
    github_pr_review_thread_reply: '↪',
    github_pr_review_thread_resolve: '⌗',
    github_pr_close: '⊖',
    github_pr_reopen: '↻',
    github_pr_comment: '✐',
    github_pr_merge: '⇉',
    github_pr_ready: '◉',
    github_pr_create: '⇪',
    run_build: '⚒',
    run_test: '🧪',
    run_lint: '☑',
    run_command: '▶',
    create_directory: '⊞',
    delete_file: '⊗',
  }
  return map[tool] || '◆'
}

function formatToolArgs(args) {
  if (!args) return ''
  const vals = Object.values(args)
  return vals[0]?.toString().slice(0, 60) || ''
}

function formatToolResult(result) {
  if (!result) return ''
  if (result.toolCancelled) return result.message || 'Tool cancelled'
  if (!result.success) return `Error: ${result.error}`
  if (result.files) return result.files.slice(0, 20).join('  ')
  if (result.matches) return result.matches.slice(0, 10).map(m => `${m.path}:${m.lineNumber}`).join('  ')
  if (result.content) return result.content.slice(0, 200) + (result.content.length > 200 ? '...' : '')
  if (result.entries) return result.entries.map(e => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`).join('  ')
  if (result.stdout) return result.stdout.slice(0, 200)
  if (result.stderr) return result.stderr.slice(0, 200)
  return result.message || 'Done'
}

function toolResultItems(msg) {
  const result = msg?.result
  if (!result || !result.success) return []
  if (msg.tool === 'read_file' && msg.args?.path) {
    return [{
      path: msg.args.path,
      line: 'Open file in inspector',
    }]
  }
  if (msg.tool === 'read_file_range' && msg.args?.path) {
    const startLine = Number(result.startLine || msg.args.startLine || 1)
    const endLine = Number(result.endLine || msg.args.endLine || startLine)
    return [{
      path: msg.args.path,
      lineNumber: startLine,
      line: `Open lines ${startLine}-${endLine} in inspector`,
    }]
  }
  if (Array.isArray(result.matches)) return result.matches.slice(0, 50)
  if (Array.isArray(result.files)) return result.files.slice(0, 50).map((filePath) => ({ path: filePath }))
  if (Array.isArray(result.entries) && msg.tool === 'list_directory') {
    const basePath = msg.args?.path || '.'
    return result.entries
      .slice(0, 50)
      .map((entry) => ({
        path: `${basePath === '.' ? '' : `${basePath}/`}${entry.name}`.replace(/\\/g, '/'),
        displayPath: entry.name,
        previewable: entry.type === 'file',
        line: entry.type === 'dir' ? 'diretorio' : 'ficheiro',
      }))
  }
  return []
}

function getToolResultItemIcon(item) {
  if (item?.previewable === false) return '📁'
  return '📄'
}

function getToolResultItemLabel(item) {
  return item?.displayPath || item?.path || ''
}

function handleToolResultItemClick(item) {
  if (!item || item.previewable === false) return
  openPreview(item)
}

function isToolResultExpanded(msg) {
  return Boolean(msg?.showAllItems)
}

function shouldShowAllToolResultItems(msg) {
  return msg?.tool === 'list_directory'
}

function canExpandToolResult(msg) {
  return toolResultItems(msg).length > TOOL_RESULT_COLLAPSED_COUNT
}

function visibleToolResultItems(msg) {
  const items = toolResultItems(msg)
  if (shouldShowAllToolResultItems(msg)) return items
  if (isToolResultExpanded(msg)) return items
  return items.slice(0, TOOL_RESULT_COLLAPSED_COUNT)
}

function getToolResultCountLabel(msg) {
  const count = toolResultItems(msg).length
  if (!count) return ''
  if (shouldShowAllToolResultItems(msg)) return `${count} item${count === 1 ? '' : 's'}`
  if (!canExpandToolResult(msg)) return `${count} item${count === 1 ? '' : 's'}`
  return isToolResultExpanded(msg)
    ? `${count} items`
    : `${Math.min(count, TOOL_RESULT_COLLAPSED_COUNT)} of ${count}`
}

function toggleToolResultExpansion(msg) {
  if (!canExpandToolResult(msg)) return
  msg.showAllItems = !msg.showAllItems
}

async function openPreview(item) {
  if (!workingDir.value || !item?.path || !window.electronAPI?.previewFile) return

  if (!previewOpen.value) {
    previewWidth.value = getDefaultPreviewWidth()
  }

  previewOpen.value = true
  previewLoading.value = true
  previewError.value = ''

  try {
    const result = await window.electronAPI.previewFile({
      workingDir: workingDir.value,
      path: item.path,
      lineNumber: item.lineNumber || null,
    })

    if (!result.success) {
      previewError.value = result.error || 'Failed to load file preview'
      return
    }

    previewState.value = result
  } catch (error) {
    previewError.value = error.message
  } finally {
    previewLoading.value = false
  }
}

function normalizeDisplayText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        if (part && typeof part.content === 'string') return part.content
        return ''
      })
      .join('\n')
  }
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
  }
  return ''
}

function getQueuedDraftModeLabel(mode) {
  if (mode === 'steer') return 'Steer next'
  if (mode === 'stop-and-send') return 'Stop and send'
  return 'Queue'
}

function findLastAssistantMessageForTurn(turnId) {
  return [...displayMessages.value]
    .reverse()
    .find((message) => message.type === 'assistant' && message.turnId === turnId)
}

function clearStreamingAssistantMessageForTurn(turnId) {
  const index = displayMessages.value.findIndex((message) => message.type === 'assistant' && message.turnId === turnId && message.isStreaming)
  if (index === -1) return

  displayMessages.value.splice(index, 1)
}

function findApprovalMessage(requestId) {
  return displayMessages.value.find((message) => message.type === 'approval' && message.requestId === requestId)
}

function findThinkingMessage(turnId) {
  return [...displayMessages.value]
    .reverse()
    .find((message) => message.type === 'thinking' && message.turnId === turnId)
}

function setThinkingIndicator(turnId, visible, text = 'Thinking...') {
  const existingMessage = findThinkingMessage(turnId)

  if (!visible) {
    if (!existingMessage) return
    const thinkingIdx = displayMessages.value.lastIndexOf(existingMessage)
    if (thinkingIdx !== -1) {
      displayMessages.value.splice(thinkingIdx, 1)
    }
    return
  }

  if (existingMessage) {
    existingMessage.text = text
    return
  }

  displayMessages.value.push({ type: 'thinking', turnId, text })
}

function rememberApprovalScope(toolName, scope) {
  if (scope === 'chat') {
    approvalPolicy.value = {
      allowAll: true,
      allowedTools: { ...approvalPolicy.value.allowedTools },
    }
    return
  }

  if (scope === 'tool' && toolName) {
    approvalPolicy.value = {
      allowAll: approvalPolicy.value.allowAll,
      allowedTools: {
        ...approvalPolicy.value.allowedTools,
        [toolName]: true,
      },
    }
  }
}

function getApprovalScopeLabel(message, scope = 'tool') {
  if (scope === 'chat') return 'commands'
  return (message?.title || message?.tool || 'commands').toLowerCase()
}

function upsertApprovalMessage(turnId, update) {
  const existingMessage = findApprovalMessage(update.requestId)
  if (existingMessage) {
    existingMessage.runId = update.runId
    existingMessage.tool = update.tool
    existingMessage.args = update.args
    existingMessage.title = update.title || 'Approval required'
    existingMessage.summary = update.summary || update.tool || 'Approval required'
    existingMessage.riskLevel = update.riskLevel || 'medium'
    return existingMessage
  }

  const approvalMessage = {
    type: 'approval',
    turnId,
    runId: update.runId,
    requestId: update.requestId,
    tool: update.tool,
    args: update.args,
    title: update.title || 'Approval required',
    summary: update.summary || update.tool || 'Approval required',
    riskLevel: update.riskLevel || 'medium',
    resolved: false,
    decision: '',
    submitting: false,
  }

  displayMessages.value.push(approvalMessage)
  return approvalMessage
}

function getApprovalStatusLabel(decision) {
  if (decision === 'approved') return 'Approved. Execution resumed.'
  if (decision === 'approved-all-tool') return 'Approved. This command type will auto-run for the rest of this chat.'
  if (decision === 'approved-all-chat') return 'Approved. All approval-gated commands will auto-run for the rest of this chat.'
  if (decision === 'denied') return 'Denied. The agent must choose a safer next step.'
  if (decision === 'cancelled') return 'Cancelled before a decision was made.'
  return 'Awaiting decision.'
}

function resolveApprovalMessagesForTurn(turnId, decision) {
  displayMessages.value
    .filter((message) => message.type === 'approval' && message.turnId === turnId && !message.resolved)
    .forEach((message) => {
      message.resolved = true
      message.decision = decision
      message.submitting = false
    })
}

async function respondToApproval(message, approved, options = {}) {
  if (!message?.requestId || message.submitting || message.resolved || !window.electronAPI?.respondToApproval) return

  message.submitting = true

  try {
    const result = await window.electronAPI.respondToApproval({
      runId: message.runId || activeRunId.value,
      requestId: message.requestId,
      approved,
      scope: approved ? (options.scope || '') : '',
      chatId: activeChatId.value,
    })

    if (!result?.success) {
      throw new Error(result?.error || 'Failed to send approval response')
    }

    if (approved && options.scope) {
      rememberApprovalScope(message.tool, options.scope)
    }

    message.resolved = true
    message.decision = options.decision || (approved ? 'approved' : 'denied')
  } catch (error) {
    message.submitting = false
    displayMessages.value.push({
      type: 'assistant',
      content: `**Error:** ${error.message}`,
      turnId: message.turnId,
    })
    await scrollToBottom()
    return
  }

  message.submitting = false
  await scrollToBottom()
}

async function syncApprovalPolicyToBackend(chatId = activeChatId.value, policy = approvalPolicy.value) {
  if (!chatId || !window.electronAPI?.setApprovalPolicy) return

  try {
    await window.electronAPI.setApprovalPolicy({
      chatId,
      approvalPolicy: toIpcSafe(policy || { allowAll: false, allowedTools: {} }),
    })
  } catch {
  }
}

function upsertAssistantMessage(turnId, content, { isStreaming = false } = {}) {
  const existingMessage = findLastAssistantMessageForTurn(turnId)
  if (existingMessage) {
    existingMessage.content = content
    existingMessage.isStreaming = isStreaming
    return
  }

  displayMessages.value.push({ type: 'assistant', content, turnId, isStreaming })
}

function stripMarkdownDecorators(value) {
  return String(value || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_]+/g, '')
    .trim()
}

function extractPreviewBasePathFromText(text) {
  const normalized = stripMarkdownDecorators(normalizeDisplayText(text))
  if (!normalized) return ''

  const folderMatch = normalized.match(/(?:dentro da pasta|inside (?:the )?folder|in folder|conte[uú]do da pasta)\s+([A-Za-z0-9_.\-/\\]+)(?=\s*[,:]|\s|$)/i)
  if (folderMatch?.[1]) {
    return folderMatch[1]
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/$/, '')
  }

  return ''
}

function isPreviewableFilePath(value) {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (/[\\/]$/.test(normalized)) return false
  return /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9_-]+$/.test(normalized)
}

function buildPreviewPath(rawPath, sourceText) {
  const normalizedPath = stripMarkdownDecorators(rawPath)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
  if (!isPreviewableFilePath(normalizedPath)) return ''
  if (normalizedPath.includes('/')) return normalizedPath

  const basePath = extractPreviewBasePathFromText(sourceText)
  return basePath ? `${basePath}/${normalizedPath}` : normalizedPath
}

function renderPreviewableCellContent(cellText, sourceText) {
  const previewPath = buildPreviewPath(cellText, sourceText)
  if (!previewPath) return cellText || '&nbsp;'

  return `<button class="assistant-preview-link" type="button" data-preview-path="${encodeURIComponent(previewPath)}" data-preview-label="${encodeURIComponent(cellText)}">${cellText}</button>`
}

function renderPreviewableTextSegment(segment, sourceText) {
  return String(segment || '').replace(/(^|[\s([{"'])((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+)(?=$|[\s)\]}",:;!?'])/g, (match, prefix, candidate) => {
    const previewPath = buildPreviewPath(candidate, sourceText)
    if (!previewPath) return match
    return `${prefix}<button class="assistant-preview-link" type="button" data-preview-path="${encodeURIComponent(previewPath)}" data-preview-label="${encodeURIComponent(candidate)}">${candidate}</button>`
  })
}

function renderPreviewableTextPaths(html, sourceText) {
  const parts = String(html || '').split(/(<[^>]+>)/g)
  let inPre = 0
  let inCode = 0
  let inButton = 0

  return parts.map((part) => {
    if (!part) return part

    if (part.startsWith('<')) {
      if (/^<pre\b/i.test(part)) inPre += 1
      else if (/^<code\b/i.test(part)) inCode += 1
      else if (/^<button\b/i.test(part)) inButton += 1
      else if (/^<\/pre>/i.test(part)) inPre = Math.max(0, inPre - 1)
      else if (/^<\/code>/i.test(part)) inCode = Math.max(0, inCode - 1)
      else if (/^<\/button>/i.test(part)) inButton = Math.max(0, inButton - 1)
      return part
    }

    if (inPre || inCode || inButton) return part
    return renderPreviewableTextSegment(part, sourceText)
  }).join('')
}

function resolvePreviewPathFromTurn(message, previewLabel) {
  const normalizedLabel = stripMarkdownDecorators(previewLabel)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\\/g, '/')

  if (!normalizedLabel) return ''

  const relevantToolMessages = [...displayMessages.value]
    .reverse()
    .filter((entry) => entry?.type === 'tool' && entry.turnId === message?.turnId && entry.tool === 'list_directory' && entry.result?.success)

  for (const toolMessage of relevantToolMessages) {
    const matchedItem = toolResultItems(toolMessage).find((item) => item.path === normalizedLabel || item.path.endsWith(`/${normalizedLabel}`))
    if (matchedItem?.path) {
      return matchedItem.path
    }
  }

  return ''
}

async function handleAssistantContentClick(event, message) {
  const trigger = event?.target?.closest?.('.assistant-preview-link')
  if (!trigger) return

  const previewLabel = decodeURIComponent(trigger.getAttribute('data-preview-label') || '')
  const previewPath = resolvePreviewPathFromTurn(message, previewLabel)
    || decodeURIComponent(trigger.getAttribute('data-preview-path') || '')
  if (!previewPath) return

  await openPreview({
    path: previewPath,
    lineNumber: null,
    line: previewLabel,
  })
}

function renderMarkdownTableSegment(segment, sourceText) {
  const lines = segment.split('\n').filter((line) => line.trim())
  if (lines.length < 2) return segment

  const headerLine = lines[0]
  const separatorLine = lines[1]
  const bodyLines = lines.slice(2)

  if (!/^\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(separatorLine.trim())) {
    return segment
  }

  const parseCells = (line) => line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())

  const headerCells = parseCells(headerLine)
  if (!headerCells.length) return segment

  const headerHtml = headerCells
    .map((cell) => `<th>${cell || '&nbsp;'}</th>`)
    .join('')

  const bodyHtml = bodyLines
    .map((line) => parseCells(line))
    .filter((cells) => cells.length > 0)
    .map((cells) => `<tr>${cells.map((cell) => `<td>${renderPreviewableCellContent(cell, sourceText)}</td>`).join('')}</tr>`)
    .join('')

  return `<table class="chat-markdown-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`
}

function renderMarkdownTables(text, sourceText) {
  return String(text || '').replace(/(^|<br>)(\|[^<\n]+\|(?:<br>\|[^<\n]+\|)+)/g, (match, prefix, block) => {
    const normalizedBlock = block.replace(/<br>/g, '\n')
    const renderedTable = renderMarkdownTableSegment(normalizedBlock, sourceText)
    if (renderedTable === normalizedBlock) return match
    return `${prefix}${renderedTable}`
  })
}

function renderMarkdown(text) {
  const displayText = normalizeDisplayText(text)
  const normalized = escapeHtml(displayText)
  if (!normalized) return ''
  return renderPreviewableTextPaths(renderMarkdownTables(normalized
    // code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
    // inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // newlines
    .replace(/\n/g, '<br>'), displayText), displayText)
}

onMounted(() => {
  inputEl.value?.focus()
  refreshGitHubStatus()
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('focus', handleWindowFocus)
})

watch([
  workingDir,
  input,
  messages,
  displayMessages,
  modelEvents,
  validationRuns,
  changeEvents,
  workflowExpandedByTurn,
  stoppedTurns,
  latestWorkflowTurnId,
  approvalPolicy,
  activeChatTitle,
  activeChatTitleManuallySet,
  conversationModelProvider,
  conversationModelLabel,
  conversationModelMeta,
  providerRuntimeState,
  chatContextSummary,
  contextSummaryExpanded,
  queuedDrafts,
], () => {
  syncActiveChatSession()
}, { deep: true })

watch([messages, displayMessages], () => {
  if (!activeChatTitleManuallySet.value) {
    activeChatTitle.value = getChatTitleFromState(displayMessages.value, messages.value)
  }
}, { deep: true })

watch(chatSessions, () => {
  saveChatSessions()
}, { deep: true })

watch(activeChatId, () => {
  saveChatSessions()
})

watch([approvalPolicy, activeChatId], ([nextApprovalPolicy, nextChatId]) => {
  syncApprovalPolicyToBackend(nextChatId, nextApprovalPolicy)
}, { deep: true, immediate: true })

onBeforeUnmount(() => {
  syncActiveChatSession()
  stopPreviewResize()
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener('focus', handleWindowFocus)
})
</script>

<style scoped>
.app {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

/* ─── Sidebar ───────────────────────────────────────────────────────────────── */

.sidebar {
  width: 260px;
  flex-shrink: 0;
  background: var(--bg-2);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-header {
  padding: 20px 18px 16px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  overflow: visible;
}

.logo {
  display: flex;
  align-items: center;
  min-height: 22px;
  gap: 10px;
  overflow: visible;
  -webkit-app-region: no-drag;
}

.logo-icon {
  font-size: 20px;
  color: var(--accent);
  filter: drop-shadow(0 0 8px var(--accent-glow));
}

.logo-text {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text);
}

.sidebar-section {
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.section-label {
  display: block;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--text-3);
  margin-bottom: 8px;
  font-family: var(--font-mono);
}

.dir-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.2s;
}

.dir-picker:hover { border-color: var(--border-bright); }

.chats-section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.chats-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chats-count {
  color: var(--text-3);
  font-size: 10px;
  font-family: var(--font-mono);
}

.chats-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.chat-session-item {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.02);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  color: var(--text-2);
  transition: all 0.2s ease;
  padding: 8px;
}

.chat-session-item:hover {
  border-color: var(--border-bright);
  color: var(--text);
}

.chat-session-item.editing {
  border-color: rgba(245, 200, 66, 0.28);
  background: linear-gradient(135deg, rgba(245, 200, 66, 0.08), rgba(124, 106, 245, 0.05));
}

.chat-session-item.active {
  border-color: rgba(93, 232, 193, 0.28);
  background: linear-gradient(135deg, rgba(93, 232, 193, 0.12), rgba(124, 106, 245, 0.06));
  color: var(--text);
}

.chat-session-main {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  width: 100%;
  min-width: 0;
}

.chat-session-main:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.chat-session-title {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-session-meta {
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-session-actions,
.chat-session-edit-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.chat-session-actions {
  align-self: flex-end;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.chat-session-action {
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255,255,255,0.03);
  color: var(--text-2);
  font-size: 10px;
  line-height: 1;
  padding: 5px 8px;
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
}

.chat-session-action:hover:not(:disabled) {
  border-color: var(--border-bright);
  color: var(--text);
}

.chat-session-action:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.chat-session-action.danger:hover:not(:disabled) {
  border-color: rgba(255, 100, 100, 0.4);
  color: #ffb0b0;
}

.chat-session-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.chat-session-rename-input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: rgba(8, 12, 22, 0.7);
  color: var(--text);
  padding: 8px 10px;
  font-size: 12px;
}

.chat-session-rename-input:focus {
  outline: none;
  border-color: rgba(245, 200, 66, 0.4);
  box-shadow: 0 0 0 1px rgba(245, 200, 66, 0.18);
}

.dir-icon { color: var(--accent); font-size: 12px; }

.dir-path {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.api-input {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11px;
  outline: none;
  transition: border-color 0.2s;
}

.api-input:focus { border-color: var(--accent); }
.api-input::placeholder { color: var(--text-3); }

.key-hint {
  display: block;
  font-size: 10px;
  color: var(--text-3);
  margin-top: 5px;
  font-family: var(--font-mono);
}

.model-card {
  background: linear-gradient(135deg, rgba(124,106,245,0.08), rgba(93,232,193,0.04));
}

.model-runtime {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-3);
}

.model-runtime.pending {
  color: #f3c97c;
}

.model-runtime.warning,
.model-runtime.error {
  color: #ff8f8f;
}

.model-runtime.ready {
  color: #7ee0a1;
}

.model-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
}

.model-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-2);
  box-shadow: 0 0 6px var(--accent-2);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.model-meta {
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
  margin-top: 4px;
}

.github-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.github-status-card {
  padding: 10px 12px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.github-status-card.clickable {
  cursor: pointer;
  transition: border-color 0.2s ease, transform 0.2s ease, background 0.2s ease;
}

.github-status-card.clickable:hover {
  transform: translateY(-1px);
  border-color: rgba(245, 200, 66, 0.4);
  background: linear-gradient(135deg, rgba(245,200,66,0.08), rgba(124,106,245,0.05));
}

.github-status-card.ready {
  border-color: rgba(93, 232, 193, 0.35);
  background: linear-gradient(135deg, rgba(93, 232, 193, 0.1), rgba(124, 106, 245, 0.05));
}

.github-status-card.warning {
  border-color: rgba(245, 200, 66, 0.25);
}

.github-status-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-mono);
}

.github-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}

.github-status-card.ready .github-status-dot {
  background: var(--accent-2);
  box-shadow: 0 0 8px rgba(93, 232, 193, 0.45);
}

.github-status-card.warning .github-status-dot {
  background: var(--yellow);
}

.github-status-body {
  margin-top: 6px;
  color: var(--text-3);
  font-size: 10px;
  line-height: 1.5;
}

.tools-list { display: flex; flex-direction: column; gap: 4px; }

.activity-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.activity-item {
  padding: 8px 10px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.activity-item.error {
  border-color: rgba(255, 100, 100, 0.35);
}

.activity-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: var(--text-2);
  font-family: var(--font-mono);
  text-transform: uppercase;
}

.activity-body {
  margin-top: 6px;
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
}

.activity-empty {
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
}

.tool-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-2);
  padding: 3px 0;
  font-family: var(--font-mono);
}

.tool-icon { color: var(--accent); font-size: 10px; width: 14px; }

.sidebar-footer {
  margin-top: auto;
  padding: 14px 18px;
  border-top: 1px solid var(--border);
}

.new-chat-btn {
  width: 100%;
  padding: 9px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.2s;
}

.new-chat-btn:hover {
  background: var(--bg-4);
  color: var(--text);
  border-color: var(--border-bright);
}

.new-chat-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* ─── Main ──────────────────────────────────────────────────────────────────── */

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 24px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  flex-shrink: 0;
}

.topbar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  font-family: var(--font-mono);
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  -webkit-app-region: no-drag;
}

.settings-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: linear-gradient(135deg, rgba(124,106,245,0.14), rgba(93,232,193,0.06));
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.settings-btn:hover {
  border-color: var(--border-bright);
  color: var(--text);
  transform: translateY(-1px);
}

.settings-btn-icon {
  color: var(--accent);
  font-size: 12px;
}

.topbar-alert {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid rgba(245, 92, 122, 0.28);
  border-radius: 999px;
  background: rgba(245, 92, 122, 0.08);
  color: #f7b4c0;
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.topbar-alert:hover {
  background: rgba(245, 92, 122, 0.12);
  border-color: rgba(245, 92, 122, 0.42);
  color: #ffd7de;
}

.topbar-alert-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--red);
  box-shadow: 0 0 8px rgba(245, 92, 122, 0.5);
}

.provider-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255,255,255,0.03);
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 11px;
}

.provider-pill-label {
  color: var(--text-3);
}

.provider-pill-value {
  color: var(--text);
}

.topbar-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
  transition: all 0.3s;
}

.topbar-status.active .status-dot {
  background: var(--accent-2);
  box-shadow: 0 0 6px var(--accent-2);
  animation: pulse 1s infinite;
}

.topbar-status.active { color: var(--accent-2); }

.approval-policy-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 24px;
  border-bottom: 1px solid rgba(93, 232, 193, 0.14);
  background: linear-gradient(90deg, rgba(93, 232, 193, 0.12), rgba(124, 106, 245, 0.04));
  flex-shrink: 0;
}

.approval-policy-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.approval-policy-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--accent-2);
}

.approval-policy-text {
  color: var(--text-2);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.approval-policy-clear {
  border: 1px solid rgba(93, 232, 193, 0.2);
  background: rgba(10, 10, 15, 0.36);
  color: var(--text);
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 11px;
  font-family: var(--font-mono);
  cursor: pointer;
  transition: all 0.2s ease;
}

.approval-policy-clear:hover {
  border-color: rgba(93, 232, 193, 0.34);
  color: var(--accent-2);
  transform: translateY(-1px);
}

.workspace {
  flex: 1;
  min-height: 0;
  display: flex;
}

.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(4, 4, 10, 0.62);
  backdrop-filter: blur(12px);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}

.settings-panel {
  width: min(520px, calc(100vw - 32px));
  height: 100%;
  background:
    radial-gradient(circle at top left, rgba(124,106,245,0.14), transparent 28%),
    radial-gradient(circle at top right, rgba(93,232,193,0.1), transparent 24%),
    var(--bg-2);
  border-left: 1px solid var(--border);
  box-shadow: -24px 0 80px rgba(0, 0, 0, 0.35);
  padding: 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow-y: auto;
}

.settings-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.settings-tabs {
  display: flex;
  gap: 8px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: rgba(255,255,255,0.02);
}

.settings-tab {
  flex: 1;
  padding: 10px 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.settings-tab.active {
  background: linear-gradient(135deg, rgba(124,106,245,0.16), rgba(93,232,193,0.08));
  color: var(--text);
}

.settings-eyebrow {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--text-3);
  font-family: var(--font-mono);
  margin-bottom: 8px;
}

.settings-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 8px;
}

.settings-subtitle {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.7;
}

.settings-close {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.03);
  color: var(--text-2);
  font-size: 20px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.settings-close:hover {
  color: var(--text);
  border-color: var(--border-bright);
  background: rgba(255,255,255,0.06);
}

.settings-section {
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: rgba(255,255,255,0.02);
}

.settings-label {
  display: block;
  font-size: 10px;
  font-family: var(--font-mono);
  letter-spacing: 0.12em;
  color: var(--text-3);
  margin-bottom: 10px;
}

.settings-input {
  padding: 12px 14px;
  font-size: 12px;
}

.settings-hint-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.settings-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.settings-badge {
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 10px;
  font-family: var(--font-mono);
}

.settings-badge.warning {
  border-color: rgba(245, 92, 122, 0.28);
  color: #f7b4c0;
}

.settings-sub-label {
  margin-top: 16px;
}

.provider-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.provider-card {
  padding: 14px;
  border-radius: 16px;
  border: 1px solid rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.025);
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  transition: all 0.2s ease;
}

.provider-card:hover {
  border-color: var(--border-bright);
  transform: translateY(-1px);
}

.provider-card.active {
  border-color: rgba(124,106,245,0.36);
  background: linear-gradient(135deg, rgba(124,106,245,0.12), rgba(93,232,193,0.06));
  color: var(--text);
}

.provider-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.provider-card-title {
  font-size: 13px;
  font-weight: 600;
}

.provider-card-tag {
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-3);
}

.provider-card.active .provider-card-tag {
  color: var(--text-2);
}

.provider-card-body {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.55;
}

.provider-card-runtime {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-3);
}

.provider-card-runtime.pending {
  color: #f3c97c;
}

.provider-card-runtime.warning,
.provider-card-runtime.error {
  color: #ff8f8f;
}

.provider-card-runtime.ready {
  color: #7ee0a1;
}

.settings-copy {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 14px;
}

.settings-copy-tight {
  margin-top: 12px;
  margin-bottom: 0;
}

.settings-github-card {
  margin-bottom: 14px;
}

.settings-budget-card {
  margin-bottom: 14px;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.06);
  background: rgba(255,255,255,0.025);
}

.settings-budget-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.settings-budget-copy-block {
  min-width: 0;
}

.settings-inline-label {
  margin-bottom: 6px;
}

.settings-budget-value {
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
}

.settings-budget-copy {
  max-width: 40ch;
  font-size: 12px;
  line-height: 1.55;
}

.settings-budget-controls {
  display: grid;
  grid-template-columns: 38px minmax(0, 88px) 38px;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
}

.settings-budget-stepper {
  height: 38px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(255,255,255,0.03);
  color: var(--text-2);
  font-size: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.settings-budget-stepper:hover {
  border-color: var(--border-bright);
  background: rgba(255,255,255,0.07);
}

.settings-budget-input {
  height: 38px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255,255,255,0.03);
  color: var(--text);
  text-align: center;
  font-size: 16px;
  font-weight: 600;
  line-height: 1;
  padding: 0 10px;
  appearance: textfield;
  -moz-appearance: textfield;
}

.settings-budget-input::-webkit-outer-spin-button,
.settings-budget-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.settings-budget-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.settings-budget-meta,
.settings-budget-range {
  color: var(--text-3);
  font-size: 11px;
  font-family: var(--font-mono);
}

.settings-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.settings-fact {
  padding: 12px;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.05);
  background: rgba(255,255,255,0.025);
}

.settings-fact-label {
  display: block;
  color: var(--text-3);
  font-size: 10px;
  font-family: var(--font-mono);
  margin-bottom: 6px;
}

.settings-fact-value {
  display: block;
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}

.settings-primary-btn {
  width: 100%;
  margin-bottom: 14px;
  padding: 11px 14px;
  border: 1px solid rgba(245, 200, 66, 0.28);
  border-radius: 14px;
  background: linear-gradient(135deg, rgba(245,200,66,0.14), rgba(124,106,245,0.08));
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.settings-primary-btn:hover {
  border-color: rgba(245, 200, 66, 0.42);
  transform: translateY(-1px);
}

.settings-tools-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.settings-tool-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.05);
  background: rgba(255,255,255,0.025);
}

.settings-tool-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.settings-tool-label {
  color: var(--text);
  font-size: 12px;
}

.settings-tool-name {
  color: var(--text-3);
  font-size: 10px;
  font-family: var(--font-mono);
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 900px) {
  .settings-panel {
    width: 100%;
    padding: 24px 18px;
  }

  .settings-facts {
    grid-template-columns: 1fr;
  }

  .provider-grid {
    grid-template-columns: 1fr;
  }

  .settings-tools-grid {
    grid-template-columns: 1fr;
  }
}

.chat-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.workflow-inline {
  border-top: 1px solid var(--border);
  background: rgba(255,255,255,0.015);
}

.workflow-inline-toggle {
  width: 100%;
  padding: 10px 12px;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
}

.workflow-inline-toggle:hover {
  background: rgba(255,255,255,0.02);
}

.workflow-inline-head,
.workflow-inline-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.workflow-inline-title {
  color: var(--text);
  font-size: 11px;
  font-family: var(--font-mono);
  text-transform: uppercase;
}

.workflow-inline-summary,
.workflow-inline-iteration,
.workflow-inline-state,
.workflow-inline-chevron {
  color: var(--text-3);
  font-size: 10px;
  font-family: var(--font-mono);
}

.workflow-inline-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workflow-inline-body {
  padding: 0 12px 12px;
}

.workflow-lines {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.workflow-line {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-2);
}

.workflow-line-label {
  flex-shrink: 0;
  color: var(--text-3);
  text-transform: uppercase;
}

.workflow-line-text {
  min-width: 0;
  word-break: break-word;
}

.workflow-line.ok .workflow-line-label {
  color: var(--accent-2);
}

.workflow-line.fail .workflow-line-label {
  color: var(--red);
}

.workflow-line.running .workflow-line-label {
  color: var(--yellow);
}

.preview-resize-handle {
  width: 6px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  position: relative;
}

.preview-resize-handle::after {
  content: '';
  position: absolute;
  inset: 0 2px;
  background: var(--border);
  opacity: 0.4;
}

.preview-resize-handle:hover::after {
  background: var(--accent);
  opacity: 0.8;
}

.preview-pane {
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.preview-pane.empty {
  background: linear-gradient(180deg, rgba(124,106,245,0.04), rgba(93,232,193,0.02));
}

.preview-header {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.preview-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 0.04em;
}

.preview-subtitle {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono);
  word-break: break-all;
}

.preview-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-language {
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  color: var(--accent-2);
  font-size: 10px;
  font-family: var(--font-mono);
  text-transform: uppercase;
}

.preview-copy {
  padding: 5px 10px;
  border: 1px solid var(--border);
  background: var(--bg-3);
  border-radius: 8px;
  color: var(--text-2);
  cursor: pointer;
  font-size: 11px;
  font-family: var(--font-mono);
}

.preview-copy:hover,
.preview-close:hover {
  border-color: var(--accent);
  color: var(--text);
}

.preview-close {
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  background: var(--bg-3);
  border-radius: 8px;
  color: var(--text-2);
  cursor: pointer;
}

.preview-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.preview-meta {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
}

.preview-code {
  margin: 0;
  padding: 16px;
  overflow: auto;
  flex: 1;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  user-select: text;
  -webkit-user-select: text;
  white-space: pre;
}

.preview-code code {
  display: block;
  user-select: text;
  -webkit-user-select: text;
}

.preview-status {
  padding: 18px 16px;
  color: var(--text-3);
  font-size: 12px;
}

.preview-status.error {
  color: var(--red);
}

/* ─── Messages ──────────────────────────────────────────────────────────────── */

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.empty-state {
  margin: auto;
  text-align: center;
  max-width: 480px;
}

.empty-icon {
  font-size: 48px;
  color: var(--accent);
  filter: drop-shadow(0 0 20px var(--accent-glow));
  margin-bottom: 16px;
}

.empty-title {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--text);
}

.empty-state p {
  color: var(--text-2);
  font-size: 14px;
  line-height: 1.6;
  margin-bottom: 24px;
}

.suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.suggestion-btn {
  padding: 8px 14px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 20px;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  font-family: var(--font-sans);
  transition: all 0.2s;
}

.suggestion-btn:hover {
  background: var(--bg-4);
  border-color: var(--accent);
  color: var(--text);
}

.message {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  animation: fadeUp 0.3s ease;
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.msg-avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  flex-shrink: 0;
}

.user-avatar {
  background: linear-gradient(135deg, var(--accent), #9b6af5);
  color: white;
  font-family: var(--font-sans);
}

.agent-avatar {
  background: var(--bg-3);
  border: 1px solid var(--border);
  color: var(--accent);
  font-size: 16px;
}

.msg-body { flex: 1; min-width: 0; }

.msg-text {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text);
  user-select: text;
}

.msg-text.streaming::after {
  content: '';
  display: inline-block;
  width: 7px;
  height: 1em;
  margin-left: 4px;
  vertical-align: -0.15em;
  border-radius: 999px;
  background: var(--accent);
  opacity: 0.8;
  animation: blinkCursor 0.9s ease-in-out infinite;
}

@keyframes blinkCursor {
  0%, 49% { opacity: 0.9; }
  50%, 100% { opacity: 0.15; }
}

.msg-text :deep(pre) {
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  overflow-x: auto;
  margin: 10px 0;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}

.msg-text :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg-3);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--accent-2);
}

.msg-text :deep(pre code) {
  background: none;
  padding: 0;
  color: var(--text);
}

.msg-text :deep(strong) { color: var(--text); font-weight: 600; }

.msg-text :deep(table) {
  width: auto;
  max-width: 100%;
  display: inline-table;
  table-layout: auto;
  border-collapse: collapse;
  margin: 10px 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  font-size: 12px;
}

.msg-text :deep(th),
.msg-text :deep(td) {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.msg-text :deep(th) {
  background: var(--bg-3);
  color: var(--text);
  font-weight: 600;
}

.msg-text :deep(td) {
  color: var(--text-2);
}

.msg-text :deep(tr:last-child td) {
  border-bottom: 0;
}

.msg-text :deep(.assistant-preview-link) {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent-2);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.msg-text :deep(.assistant-preview-link:hover) {
  color: var(--text);
  text-decoration: underline;
}

/* Tool calls */
.tool-call {
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-left: 2px solid var(--accent);
  border-radius: var(--radius-sm);
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  animation: fadeUp 0.2s ease;
  width: 100%;
}

.tool-call-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-3);
}

.tool-call-header.expandable {
  cursor: pointer;
}

.tool-call-header.expandable:hover {
  background: rgba(255,255,255,0.03);
}

.tool-call-progress {
  padding: 8px 12px;
  color: var(--text-3);
  border-top: 1px solid var(--border);
  background: rgba(255,255,255,0.02);
}

.tool-call-icon { color: var(--accent); }
.tool-call-name { color: var(--accent); font-weight: 500; }
.tool-call-args { flex: 1; min-width: 0; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tool-call-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.tool-call-count {
  color: var(--text-3);
}

.tool-call-chevron {
  color: var(--accent);
  font-size: 16px;
  line-height: 1;
}

.tool-call-result {
  padding: 8px 12px;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-all;
  border-top: 1px solid var(--border);
  max-height: 120px;
  overflow-y: auto;
}

.tool-call-result.expanded {
  max-height: 560px;
}

.tool-call-result.error { color: var(--red); }

.approval-card {
  min-width: 0;
  max-width: min(100%, 640px);
  display: grid;
  gap: 5px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(18,20,31,0.92);
}

.approval-card.risk-medium {
  border-color: rgba(255, 184, 77, 0.28);
}

.approval-card.risk-high {
  border-color: rgba(255, 107, 107, 0.34);
}

.approval-card.resolved {
  opacity: 0.92;
}

.approval-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.approval-title {
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
}

.approval-risk {
  color: #f3c97c;
  font-size: 9px;
  letter-spacing: 0.08em;
}

.approval-summary,
.approval-args,
.approval-status {
  color: var(--text-2);
  font-size: 10px;
  line-height: 1.3;
}

.approval-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.approval-card .composer-btn {
  height: 24px;
  padding: 0 8px;
  font-size: 10px;
}

.tool-result-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 1px solid var(--border);
  background: var(--bg-3);
  color: var(--text-2);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  cursor: default;
}

.tool-result-item.clickable {
  cursor: pointer;
}

.tool-result-item.clickable:hover {
  border-color: var(--accent);
  color: var(--text);
}

.tool-result-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tool-result-item-icon {
  flex-shrink: 0;
}

.tool-result-item-path,
.tool-result-item-line,
.tool-result-item-text {
  display: block;
}

.tool-result-item-path {
  font-weight: 600;
  color: var(--text);
  word-break: break-word;
}

.tool-result-item-line {
  color: var(--accent);
  flex-shrink: 0;
}

.tool-result-item-text {
  color: var(--text-3);
  flex-shrink: 0;
  white-space: nowrap;
}

/* Thinking */
.thinking {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 4px 0;
  padding-left: 46px;
}

.thinking-label {
  margin-left: 8px;
  color: var(--text-3);
  font-size: 12px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: bounce 1.2s infinite;
}

.thinking-dot:nth-child(2) { animation-delay: 0.2s; }
.thinking-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-6px); opacity: 1; }
}

/* ─── Input ─────────────────────────────────────────────────────────────────── */

.input-area {
  padding: 16px 24px 20px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.input-hint-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
  min-width: 0;
}

.context-meter-inline {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 0 0 8px;
  color: var(--text-3);
  font-size: 10px;
  font-family: var(--font-mono);
  flex-shrink: 0;
}

.context-meter-inline.warning {
  color: #f3c97c;
}

.context-meter-inline.full {
  color: #ff9eb0;
}

.context-meter-inline-label,
.context-meter-inline-value {
  white-space: nowrap;
}

.context-meter-inline-bar {
  width: 72px;
  height: 4px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(255,255,255,0.06);
}

.context-meter-inline-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 0.2s ease;
}

.context-meter-inline.warning .context-meter-inline-fill {
  background: linear-gradient(90deg, #f3c97c, #f0a96e);
}

.context-meter-inline.full .context-meter-inline-fill {
  background: linear-gradient(90deg, #ff8f8f, #f55c7a);
}

.context-meter-inline-toggle {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}

.context-meter-inline-toggle:hover {
  color: var(--text);
}

.context-summary-card {
  margin-top: 8px;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.input-wrapper {
  display: flex;
  gap: 10px;
  align-items: flex-end;
  background: var(--bg-2);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius);
  padding: 12px 14px;
  transition: border-color 0.2s;
}

.input-wrapper:focus-within { border-color: var(--accent); }
.input-wrapper.disabled { opacity: 0.5; }

.input-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.chat-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 14px;
  resize: none;
  line-height: 1.5;
  min-height: 22px;
  max-height: 160px;
  user-select: text;
}

.chat-input::placeholder { color: var(--text-3); }

.composer-btn {
  border: 1px solid var(--border);
  background: var(--bg-3);
  color: var(--text-2);
  border-radius: 999px;
  height: 32px;
  padding: 0 12px;
  font-size: 12px;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s, background 0.2s;
}

.composer-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.composer-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.composer-btn-secondary {
  background: transparent;
}

.composer-btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}

.composer-btn-primary:hover:not(:disabled) {
  background: #9b6af5;
  border-color: #9b6af5;
  box-shadow: 0 0 12px var(--accent-glow);
}

.composer-btn-icon {
  width: 32px;
  padding: 0;
  justify-content: center;
  font-size: 16px;
}

.spinner { animation: spin 1s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

.input-hint {
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
  padding-left: 2px;
  min-width: 0;
}

.queued-draft {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.queued-draft-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.queued-draft-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.queued-draft-label {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.queued-draft-text {
  font-size: 13px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.queued-draft-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.queued-draft-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-3);
}

.queued-draft-item-copy {
  min-width: 0;
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}

.queued-draft-item-order,
.queued-draft-item-mode {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-3);
  text-transform: uppercase;
}

.queued-draft-item-text {
  min-width: 0;
  font-size: 13px;
  color: var(--text-2);
  word-break: break-word;
}

.queued-draft-clear {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  border-radius: 999px;
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  cursor: pointer;
}

.queued-draft-clear:hover {
  border-color: var(--accent);
  color: var(--text);
}

.queued-draft-remove {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  border-radius: 999px;
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}

.queued-draft-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.queued-draft-shift {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  border-radius: 999px;
  width: 28px;
  height: 28px;
  font-size: 12px;
  cursor: pointer;
}

.queued-draft-shift:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}

.queued-draft-shift:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.queued-draft-remove:hover {
  border-color: var(--accent);
  color: var(--text);
}

@media (max-width: 1200px) {
  .preview-resize-handle,
  .preview-pane {
    display: none;
  }
}
</style>
