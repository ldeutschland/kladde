import { useEffect, useRef, useState } from "react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import {
  loadChat,
  storeChat,
  storedThread,
  writeThread,
  type ChatToStore,
} from "./chatStore";
import { withMemory } from "./memoryMarks";
import type { Item } from "./types";

export function useChatThread(book: Notebook, t: T) {
  const [thread, setThread] = useState<Item[]>([]),
    [chat, setChat] = useState<string | null>(null);
  const alive = useRef(true),
    shownChat = useRef<string | null>(null),
    scroller = useRef<HTMLDivElement>(null);

  shownChat.current = chat;

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
    };
  }, [book]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [thread]);

  async function show(id: string) {
    const saved = await loadChat(book, id);

    if (!saved || !alive.current) return null;
    setThread(saved.items);
    setChat(id);

    return saved;
  }

  function clear() {
    setThread([]);
    setChat(null);
  }

  function showIfAlive(items: Item[]) {
    if (alive.current) setThread(items);
  }

  async function save(stored: ChatToStore) {
    const id = await storeChat(book, t, stored);

    if (alive.current) setChat(id);
    await book.flush();

    return id;
  }

  async function patchReply(id: string, index: number, patch: Partial<Item>) {
    const items = await storedThread(book, id);

    if (items[index]?.role !== "assistant") return;
    items[index] = { ...items[index], ...patch };
    if (alive.current && shownChat.current === id) setThread(items);
    await writeThread(book, id, items);
    await book.flush();
  }

  function dropSavingMemory(id: string) {
    if (alive.current && shownChat.current === id)
      setThread((shown) => withMemory(shown, undefined));
  }

  return {
    thread,
    setThread,
    showIfAlive,
    chat,
    alive,
    scroller,
    show,
    clear,
    save,
    patchReply,
    dropSavingMemory,
  };
}

export type ChatThread = ReturnType<typeof useChatThread>;
