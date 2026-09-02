"use client"

import { PanelLeft, Search } from "lucide-react"
import { useRouter } from "next/navigation"
import * as React from "react"

import { AppHeader, AppHeaderActions, AppHeaderButton } from "@/components/app-header"
import { ChatChanges } from "@/components/chat-changes"
import { ThreadLoading } from "@/components/chat-skeletons"
import { ChatSidebarPanel } from "@/components/chat-sidebar-panel"
import { CHAT_SUGGESTIONS } from "@/components/chat-suggestions"
import { CommandPalette } from "@/components/command-palette"
import { ContextUsage, useDraftStore } from "@/components/context-usage"
import { FolderPicker } from "@/components/folder-picker"
import { HandoffNotice } from "@/components/handoff-notice"
import { MemoryNotice } from "@/components/memory-notice"
import { MessageActions } from "@/components/message-actions"
import { PermissionPicker } from "@/components/permission-picker"
import { ProviderPicker } from "@/components/provider-picker"
import { StashMenu } from "@/components/stash-menu"
import { ChatInput } from "@/components/ui/chat-input"
import { FilePreview } from "@/components/ui/file-preview"
import { MessageList } from "@/components/ui/message-list"
import { DEFAULT_MODEL_EFFORTS, ModelPicker } from "@/components/ui/model-picker"
import { PromptSuggestions } from "@/components/ui/prompt-suggestions"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { TodoPanel } from "@/components/ui/todo-list"
import { providerSessionHints } from "@/lib/handoff/types"
import { APP_SLASH_COMMANDS } from "@/lib/slash-commands"
import type { StoredMessage } from "@/lib/store/types"
import { cn } from "@/lib/utils"

import { EMPTY_MESSAGES, type SessionRun } from "./hooks/chat-types"
import { useAgentConfig } from "./hooks/use-agent-config"
import { useAttention } from "./hooks/use-attention"
import { useChatActions } from "./hooks/use-chat-actions"
import { useChatBootstrap } from "./hooks/use-chat-bootstrap"
import { useChatNav } from "./hooks/use-chat-nav"
import { useChatRefs, useMirrorRefs } from "./hooks/use-chat-refs"
import { useChatShortcuts } from "./hooks/use-chat-shortcuts"
import { useChatTurns } from "./hooks/use-chat-turns"
import { useCommandPalette } from "./hooks/use-command-palette"
import { useComposerDrafts } from "./hooks/use-composer-drafts"
import { useComposerHeight } from "./hooks/use-composer-height"
import {
  CHAT_PANEL_ID,
  MAX_PREVIEW_SIZE,
  MIN_PREVIEW_SIZE,
  PREVIEW_PANEL_ID,
  WORKSPACE_GROUP_ID,
  useFilePanel,
} from "./hooks/use-file-panel"
import { useIsDesktop } from "./hooks/use-is-desktop"
import { useMemoryNotices } from "./hooks/use-memory-notices"
import { useMessageQueue } from "./hooks/use-message-queue"
import { usePromptStash } from "./hooks/use-prompt-stash"
import { useSessionIndex } from "./hooks/use-session-index"
import { useSidebarItems } from "./hooks/use-sidebar-items"
import { useThreadView } from "./hooks/use-thread-view"
import { useThreads } from "./hooks/use-threads"
import { useTurnRunner } from "./hooks/use-turn-runner"

/**
 * The chat surface. Deliberately a pure client component: sessions, providers
 * and settings are fetched from the app's routes after mount (seeded from a
 * localStorage snapshot so the sidebar paints immediately), and nothing on the
 * critical path waits on the server.
 *
 * This file is the composition root and the layout — the state behind it lives
 * in `app/hooks/`, one hook per concern, wired together here in the order the
 * data flows: the index, then the threads, then what a turn runs with, then the
 * turn itself, then everything derived for the view.
 */
export default function ChatPage() {
  const router = useRouter()
  const isDesktop = useIsDesktop()
  const refs = useChatRefs()
  const { composerRef, sessionsRef } = refs

  const index = useSessionIndex()
  const {
    sessions,
    setSessions,
    activeId,
    setActiveId,
    sessionsLoaded,
    setSessionsLoaded,
    patchLocal,
    renameSession,
    togglePin,
    regenerateTitle,
  } = index

  const { threads, setThreads, cacheThread, loadThread } = useThreads(refs)

  const config = useAgentConfig({ refs, patchLocal })
  const {
    settings,
    providers,
    providerId,
    models,
    capabilities,
    visionModels,
    model,
    effort,
    setEffort,
    permissionModes,
    chosenPermission,
    effectivePermission,
    adoptAgent,
    chooseProvider,
    configureProvider,
    chooseModel,
    choosePermission,
    providerName,
    showEfforts,
    activeProviderName,
    pickerGroups,
  } = config

  const {
    collapsed,
    setCollapsed,
    closedSections,
    toggleSection,
    paletteOpen,
    setPaletteOpen,
    openPalette,
    renameRequest,
    startRename,
    drawerOpen,
    drawerTriggerRef,
    closeDrawer,
    closeNav,
    openNav,
    toggleSidebar,
  } = useChatNav({ isDesktop, sessionsRef })

  /*
   * Which chats are running, and which ended badly. Shared spine: the turn
   * runner writes them, the sidebar and the header read them, and deleting a
   * chat drops its entry — so they sit here rather than inside one hook.
   */
  const [runs, setRuns] = React.useState<Record<string, SessionRun>>({})
  const [failures, setFailures] = React.useState<Record<string, boolean>>({})

  const messages: StoredMessage[] = threads[activeId] ?? EMPTY_MESSAGES
  const activeSession = sessions.find((session) => session.id === activeId)
  const activeRun = runs[activeId]
  const isGenerating = !!activeRun
  const activeCwd = activeSession?.cwd
  const activeFolder = activeSession?.cwd?.trim() ?? ""
  const revertProvider = activeSession?.providerId || providerId
  const threadLoading =
    !!activeId &&
    threads[activeId] === undefined &&
    (activeSession?.messageCount ?? 0) > 0
  const isEmptyChat = messages.length === 0 && !threadLoading
  /**
   * What each agent already holds in this chat, for the composer's provider
   * list. Left to the compiler to memoize — a hand-written `useMemo` over a
   * value derived from `sessions` is exactly the shape it refuses to preserve.
   */
  const sessionHints = providerSessionHints(
    activeSession?.agentSessions,
    activeSession?.cwd
  )

  const panel = useFilePanel({
    refs,
    activeId,
    activeCwd,
    revertProvider,
    defaultEditor: settings?.editor.defaultEditor ?? "",
  })
  const {
    preview,
    previewSize,
    previewPrefs,
    closePreview,
    saveSplit,
    setDiffLayout,
    setWrap,
    handleCopyPath,
    fileActions,
    resolveFileUrl,
    handleOpenFile,
    handleChangeFileClick,
    handleFileReferenceClick,
    handleChatChangeClick,
    handleReviewChanges,
  } = panel

  const { memoryNotices, setMemoryNotices, runMemoryUpdate, dismissMemoryNotice } =
    useMemoryNotices(refs)

  const { stash, parkDraft, handleStash, restoreStash, discardStash } =
    usePromptStash(refs)

  const {
    queues,
    setQueues,
    queueItems,
    handleQueue,
    takeQueued,
    handleQueueRemove,
    handleQueueEdit,
  } = useMessageQueue({ refs, activeId, parkDraft })

  /*
   * The mirrors are written here, before the composer's draft effect below:
   * restoring a chat's parked draft calls the composer's `onTextChange`
   * synchronously, and that handler reads `activeIdRef` to decide which chat
   * to save the text under. A mirror one render behind would file the newly
   * opened chat's draft under the one just left.
   */
  useMirrorRefs(refs, {
    threads,
    activeId,
    sessions,
    providers,
    providerId,
    model,
    settings,
    queues,
  })

  const draftStore = useDraftStore()
  const { draftsRef, handleTextChange, handleMentions, handleQuote } =
    useComposerDrafts({ refs, activeId, draftStore })

  const {
    selectSession,
    openFolder,
    setFolder,
    removeSession,
    removeSessions,
    handleNewChat,
  } = useChatActions({
    refs,
    sessions,
    activeId,
    activeFolder,
    openThreadLength: messages.length,
    providerId,
    model,
    chosenPermission,
    setSessions,
    setActiveId,
    setThreads,
    setRuns,
    setFailures,
    setQueues,
    patchLocal,
    cacheThread,
    loadThread,
    adoptAgent,
    closePreview,
    closeNav,
    draftsRef,
  })

  const runPrompt = useTurnRunner({
    refs,
    setThreads,
    setRuns,
    setFailures,
    setMemoryNotices,
    patchLocal,
    runMemoryUpdate,
    notificationSounds: settings?.chat.notificationSounds,
  })

  const pushSettings = React.useCallback(
    () => router.push("/settings"),
    [router]
  )
  /** The void wrapper the sidebar, the palette and ⌘N all share. */
  const startNewChat = React.useCallback(
    () => void handleNewChat(),
    [handleNewChat]
  )

  const {
    send,
    handleSend,
    handleStop,
    handleAskAnswer,
    handleEditMessage,
    handleRegenerate,
    handleDeleteMessage,
  } = useChatTurns({
    refs,
    runPrompt,
    activeId,
    sessions,
    providers,
    providerId,
    model,
    effort,
    capabilities,
    visionModels,
    chosenPermission,
    autoTitle: settings?.chat.autoTitle,
    patchLocal,
    setSessions,
    setActiveId,
    setThreads,
    setRuns,
    setFailures,
    takeQueued,
    handleNewChat,
    renameSession,
    regenerateTitle,
    startRename,
    openFolder,
    pushSettings,
  })

  const {
    listMessages,
    todos,
    contextTurn,
    contextTotal,
    activeCost,
    pendingAsk,
    waitingCount,
    chatChanges,
  } = useThreadView({
    messages,
    threads,
    activeId,
    runs,
    models,
    model,
    isGenerating,
  })

  const { sessionItems, pinnedItems, folderGroups, sessionMenuActions } =
    useSidebarItems({
      refs,
      sessions,
      runs,
      failures,
      activeId,
      providerId,
      models,
      providerName,
      regenerateTitle,
    })

  const { paletteActions, paletteSessions } = useCommandPalette({
    sessions,
    activeId,
    activeCwd,
    providerName,
    regenerateTitle,
    openFolder,
  })

  useChatBootstrap({
    seedFromCache: index.seedFromCache,
    hydrateConfig: config.hydrate,
    hydrateSessions: index.hydrate,
    adoptAgent,
    setSessionsLoaded,
    loadThread,
  })

  useAttention({
    waitingCount,
    activeTitle: activeSession?.title?.trim() ?? "",
  })

  useChatShortcuts({ refs, handleNewChat, toggleSidebar, openFolder })

  const { chatPaneRef, composerBoxRef } = useComposerHeight()

  // The file panel is a resizable pane on desktop and an overlay below md.
  // Derived, so exactly one FilePreview is ever mounted.
  const dockedPreview = isDesktop ? preview : null
  const overlayPreview = isDesktop ? null : preview

  /**
   * The composer holds the draft the user is typing and has nothing to do with
   * the answer streaming above it, so it is kept off the per-frame render path.
   */
  const composer = React.useMemo(
    () => (
      <ChatInput
        ref={composerRef}
        onSend={handleSend}
        onStop={handleStop}
        onTextChange={handleTextChange}
        onQueue={handleQueue}
        queue={queueItems}
        onQueueRemove={handleQueueRemove}
        onQueueEdit={handleQueueEdit}
        onStash={handleStash}
        mentions={handleMentions}
        slashCommands={APP_SLASH_COMMANDS}
        isGenerating={isGenerating}
        placeholder={
          isGenerating
            ? undefined
            : pendingAsk
              ? "Add more optional details…"
              : activeProviderName
                ? `Ask ${activeProviderName}…`
                : "Ask anything"
        }
        /* The composer already measures like the message column; the empty
           chat only closes the gap under it, since the suggestions land there. */
        className={cn(
          "transition-[padding] duration-300 ease-out",
          isEmptyChat && "pb-0 sm:pb-0"
        )}
        tools={
          <>
            <ProviderPicker
              providers={providers}
              value={providerId}
              onChange={chooseProvider}
              sessions={sessionHints}
              onConfigure={configureProvider}
            />
            <ModelPicker
              value={model}
              onChange={chooseModel}
              options={models}
              /* One section is just the flat list with a heading over it. */
              groups={pickerGroups.length > 1 ? pickerGroups : undefined}
              efforts={showEfforts ? DEFAULT_MODEL_EFFORTS : false}
              effort={effort}
              onEffortChange={setEffort}
              side="top"
              className="min-w-0"
            />
            {permissionModes.length > 0 && effectivePermission ? (
              <PermissionPicker
                modes={permissionModes}
                value={effectivePermission}
                onChange={choosePermission}
              />
            ) : null}
            <ContextUsage
              store={draftStore}
              input={contextTurn.input}
              output={contextTurn.output}
              total={contextTotal}
              cost={activeCost}
            />
            <StashMenu
              entries={stash}
              onRestore={restoreStash}
              onDiscard={discardStash}
            />
          </>
        }
      />
    ),
    [
      activeCost,
      activeProviderName,
      chooseModel,
      choosePermission,
      chooseProvider,
      composerRef,
      configureProvider,
      contextTotal,
      contextTurn.input,
      contextTurn.output,
      discardStash,
      draftStore,
      effectivePermission,
      effort,
      handleMentions,
      handleQueue,
      handleQueueEdit,
      handleQueueRemove,
      handleSend,
      handleStash,
      handleStop,
      handleTextChange,
      isEmptyChat,
      isGenerating,
      model,
      models,
      pendingAsk,
      permissionModes,
      pickerGroups,
      providerId,
      providers,
      queueItems,
      restoreStash,
      sessionHints,
      setEffort,
      showEfforts,
      stash,
    ]
  )

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden bg-background">
      {/* Below md the sidebar slides over the conversation instead of squeezing it. */}
      <div
        aria-hidden={!drawerOpen}
        onClick={closeDrawer}
        className={cn(
          "absolute inset-0 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity duration-200 motion-reduce:transition-none md:hidden",
          drawerOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <div
        // Off-canvas below md: keep the hidden drawer out of the tab order.
        inert={!isDesktop && !drawerOpen}
        className={cn(
          "z-50 h-full shrink-0 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:shadow-xl max-md:transition-transform max-md:duration-200 max-md:motion-reduce:transition-none md:relative",
          !drawerOpen && "max-md:-translate-x-full"
        )}
      >
        <ChatSidebarPanel
          sessionItems={sessionItems}
          pinnedItems={pinnedItems}
          folderGroups={folderGroups}
          activeId={activeId}
          sessionsLoaded={sessionsLoaded}
          sessionsRef={sessionsRef}
          closedSections={closedSections}
          onToggleSection={toggleSection}
          renameRequest={renameRequest}
          isDesktop={isDesktop}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          onCloseDrawer={closeDrawer}
          onNewChat={startNewChat}
          onOpenPalette={openPalette}
          onOpenSettings={pushSettings}
          onSelect={selectSession}
          onRename={renameSession}
          onTogglePin={togglePin}
          onDelete={removeSession}
          onDeleteMany={removeSessions}
          onReorder={setSessions}
          getMenuActions={sessionMenuActions}
        />
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <AppHeader>
          <button
            ref={drawerTriggerRef}
            type="button"
            aria-label="Open chats"
            aria-expanded={drawerOpen}
            title="Open chats"
            onClick={openNav}
            className="-ml-1 inline-grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden [&_svg]:size-4"
          >
            <PanelLeft />
          </button>
          <AppHeaderActions>
            <ChatChanges
              files={chatChanges}
              fileActions={fileActions}
              onFileClick={handleChatChangeClick}
            />
            <AppHeaderButton
              label="Search chats and commands"
              hint="⌘K"
              onClick={openPalette}
            >
              <Search />
            </AppHeaderButton>
          </AppHeaderActions>
        </AppHeader>

        {/*
          Everything below the header — the header itself spans the full width
          right of the sidebar, because it doubles as the desktop window's drag
          chrome and must never be covered or squeezed by the file panel. The
          `relative` here is what the below-md overlay anchors to.
        */}
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {/*
            Desktop: the conversation and the file panel are two panes of one
            draggable split. A pane's content wrapper carries an inline
            `overflow: auto`, so the children that own their own scrolling turn
            it off through `style` — a class would lose to the inline rule.
          */}
          <ResizablePanelGroup
            id={WORKSPACE_GROUP_ID}
            orientation="horizontal"
            onLayoutChanged={saveSplit}
            className="min-w-0 flex-1"
          >
            <ResizablePanel
              id={CHAT_PANEL_ID}
              defaultSize={`${100 - previewSize}%`}
              minSize="40%"
              className="flex min-w-0 flex-col"
              style={{ overflow: "hidden" }}
            >
              <div
                ref={chatPaneRef}
                className={cn(
                  "relative flex min-h-0 flex-1 flex-col overflow-x-hidden",
                  isEmptyChat && "justify-center"
                )}
              >
                {threadLoading ? (
                  <ThreadLoading />
                ) : isEmptyChat ? (
                  <div
                    data-slot="chat-opening"
                    className="mx-auto w-full max-w-3xl px-3 pb-5 sm:px-4"
                  >
                    <h2 className="text-center text-2xl font-semibold tracking-tight text-balance text-foreground sm:text-3xl">
                      How can I help?
                    </h2>
                  </div>
                ) : (
                  <MessageList
                    /* Room for the island above, inside the scroller — so the
                       last turn settles just clear of it and everything above
                       still scrolls the whole height of the pane. */
                    className="pb-[calc(var(--composer-height,7rem)+0.5rem)]"
                    messages={listMessages}
                    isGenerating={isGenerating}
                    generationStage={activeRun?.stage ?? "idle"}
                    generationLabel={activeRun?.status}
                    onEditMessage={handleEditMessage}
                    onAskAnswer={handleAskAnswer}
                    onOpenFile={handleOpenFile}
                    onChangeFileClick={handleChangeFileClick}
                    onFileReferenceClick={handleFileReferenceClick}
                    onReviewChanges={handleReviewChanges}
                    resolveFileUrl={resolveFileUrl}
                    fileActions={fileActions}
                    onQuote={handleQuote}
                    renderActions={(message) =>
                      message.sender === "assistant" ? (
                        <>
                          {/* Attached to the turn it explains, through the
                              list's own render slot — the vendored component
                              knows nothing about handoffs. */}
                          {(message as StoredMessage).metadata?.handoff ? (
                            <HandoffNotice
                              handoff={
                                (message as StoredMessage).metadata!.handoff!
                              }
                            />
                          ) : null}
                          <MessageActions
                            message={message as StoredMessage}
                            providerName={providerName(
                              (message as StoredMessage).metadata?.providerId ??
                                ""
                            )}
                            onRegenerate={handleRegenerate}
                            onDelete={handleDeleteMessage}
                          />
                        </>
                      ) : null
                    }
                  >
                    {/* Composed in through the list's own `children` slot: the
                        marker belongs after the last turn, inside the
                        conversation column, and `MessageList` stays
                        untouched. */}
                    {memoryNotices[activeId] && !isGenerating ? (
                      <MemoryNotice
                        changes={memoryNotices[activeId].changes}
                        compacted={memoryNotices[activeId].compacted}
                        onDismiss={() => dismissMemoryNotice(activeId)}
                      />
                    ) : null}
                  </MessageList>
                )}

                <div
                  ref={composerBoxRef}
                  data-slot="chat-composer"
                  className={cn(
                    "w-full shrink-0",
                    // An island over the conversation, not a band beside it:
                    // the wrapper spans the pane so the composer stays centred,
                    // but only its children take the pointer, which leaves the
                    // transcript scrollable right up to the window's edge.
                    !isEmptyChat &&
                      "pointer-events-none absolute inset-x-0 bottom-0 z-20 [&>*]:pointer-events-auto"
                  )}
                >
                  {isEmptyChat ? (
                    /* Aligned with the composer card's own measure, so the two
                       read as one control rather than two stacked ones. */
                    <div className="mx-auto flex w-full max-w-3xl px-3 pb-2 sm:px-4">
                      <FolderPicker
                        variant="inline"
                        cwd={activeSession?.cwd}
                        gitBranch={activeSession?.gitBranch}
                        onChange={setFolder}
                      />
                    </div>
                  ) : null}
                  {/* The plan the turn is working through, collapsed to one
                      line. Keyed by chat so switching threads never carries a
                      disclosure — or a plan — across. */}
                  <TodoPanel key={activeId} items={todos} />
                  {composer}
                  {isEmptyChat && (settings?.chat.showSuggestions ?? true) ? (
                    <PromptSuggestions
                      items={CHAT_SUGGESTIONS}
                      onSelect={(item) => void send(item.label, [], [])}
                    />
                  ) : null}
                </div>
              </div>
            </ResizablePanel>

            {dockedPreview ? (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel
                  id={PREVIEW_PANEL_ID}
                  defaultSize={`${previewSize}%`}
                  minSize={`${MIN_PREVIEW_SIZE}%`}
                  maxSize={`${MAX_PREVIEW_SIZE}%`}
                  className="flex min-w-0 flex-col"
                  style={{ overflow: "hidden" }}
                >
                  <FilePreview
                    file={dockedPreview}
                    onClose={closePreview}
                    actions={fileActions}
                    onCopyPath={handleCopyPath}
                    diffLayout={previewPrefs.layout}
                    onDiffLayoutChange={setDiffLayout}
                    wrap={previewPrefs.wrap}
                    onWrapChange={setWrap}
                    className="border-l"
                  />
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>

          {/*
            Below md the file panel slides over the conversation, like the
            sidebar — but inside this wrapper, so it stops at the header.
          */}
          <div
            aria-hidden={!preview}
            onClick={closePreview}
            className={cn(
              "absolute inset-0 z-40 bg-foreground/20 backdrop-blur-[1px] transition-opacity duration-200 motion-reduce:transition-none md:hidden",
              preview ? "opacity-100" : "pointer-events-none opacity-0"
            )}
          />
          <div
            data-slot="chat-file-panel"
            // Off-canvas when closed: keep it out of the tab order either way.
            inert={!preview}
            className={cn(
              "absolute inset-y-0 right-0 z-50 w-[min(30rem,100%)] overflow-hidden bg-background shadow-xl",
              "transition-transform duration-300 ease-in-out motion-reduce:transition-none md:hidden",
              !preview && "translate-x-full"
            )}
          >
            {overlayPreview ? (
              <FilePreview
                file={overlayPreview}
                onClose={closePreview}
                actions={fileActions}
                onCopyPath={handleCopyPath}
                diffLayout={previewPrefs.layout}
                onDiffLayoutChange={setDiffLayout}
                wrap={previewPrefs.wrap}
                onWrapChange={setWrap}
                className="border-l"
              />
            ) : null}
          </div>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={paletteSessions}
        activeId={activeId}
        onSelectSession={selectSession}
        onNewChat={startNewChat}
        onRenameSession={startRename}
        actions={paletteActions}
      />
    </div>
  )
}
