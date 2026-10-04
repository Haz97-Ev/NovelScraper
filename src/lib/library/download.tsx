import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai/react";
import { atom } from "jotai/vanilla";
import { useEffect, useRef, useState } from "react";
import clone from "clone";
import { message } from "@tauri-apps/plugin-dialog";
import { SourceIDsT, SOURCES } from "../sources/sources";
import { NovelDownloadStateT, NovelT } from "../sources/types";
import { activeNovelAtom, appStateAtom, DEFAULT_MAX_CONCURRENT_DOWNLOADS, DEFAULT_QUEUE_LIMIT, dockerAtom, downloadStatusAtom, libraryStateAtom, searchHistoryAtom } from "../store";
import { fetchMetadataForNovel, getNovelChapters, getNovelStore, saveNovelCover, saveNovelEpub } from "./library";
import EpubTemplate from "./epub";

// Novels currently being prepared or downloaded, so a second click can't start a duplicate download
const activeDownloads = new Set<string>();

export const isNovelDownloading = (novelId: string) => activeDownloads.has(novelId);

export const isNovelFullyDownloaded = (novel: NovelT) =>
	novel.downloadedChapters > 0 && novel.downloadedChapters >= (novel.totalChapters ?? 0);

// Whether the novel itself is finished on its source site (not whether it's downloaded)
export const isNovelCompleted = (novel: NovelT) => !!novel.status?.toLowerCase().includes("complete");

export function useNovelDownloader() {
	const store = useStore();
	const appState = useAtomValue(appStateAtom);
	const setLibraryState = useSetAtom(libraryStateAtom);
	const setSearchHistory = useSetAtom(searchHistoryAtom);
	const setDownloadStatus = useSetAtom(downloadStatusAtom);
	const setActiveNovel = useSetAtom(activeNovelAtom);

	const saveNovel = (_novel: NovelT) => {
		setLibraryState((library) => {
			library.novels[_novel.id] = _novel;
		});
		setSearchHistory((state) => {
			const novels = state[_novel.source as SourceIDsT];
			const novelIndex = novels.findIndex((n) => n.id === _novel.id);
			if (novelIndex >= 0) novels[novelIndex] = _novel;
		});
		if (store.get(activeNovelAtom)?.id === _novel.id) setActiveNovel(_novel);
	}

	// Adds the novel to the library (loading its metadata and cover first if needed)
	const addToLibrary = async (_novel: NovelT) => {
		let libNovel = clone(store.get(libraryStateAtom).novels[_novel.id] ?? _novel);
		if (libNovel.isInLibrary) return libNovel;

		if (!libNovel.isMetadataLoaded) {
			libNovel = await fetchMetadataForNovel(libNovel);
			if (!libNovel.isMetadataLoaded) throw new Error(`Couldn't get metadata for ${libNovel.title}`);
		}
		libNovel.isInLibrary = true;
		libNovel.addedToLibraryAt = new Date().toISOString();
		libNovel.localCoverPath = await saveNovelCover(libNovel);
		saveNovel(libNovel);
		return libNovel;
	}

	const setNovelDownloadState = (novelId: string, downloadState: NovelDownloadStateT) => {
		setLibraryState((library) => {
			if (library.novels[novelId]) library.novels[novelId].downloadState = downloadState;
		});
	}

	// Downloads a novel (resuming from its saved chapters), adding it to the library first if it isn't there yet.
	// Returns false if the download failed. `quiet` skips the error dialog, for scheduled downloads.
	const downloadNovel = async (_novel: NovelT, { quiet = false } = {}) => {
		if (activeDownloads.has(_novel.id)) return true;
		if (store.get(downloadStatusAtom)[_novel.id]?.status === "Downloading") return true;
		activeDownloads.add(_novel.id);
		try {
			const novel = await addToLibrary(_novel);
			const novelSource = SOURCES[novel.source];
			setNovelDownloadState(novel.id, "Downloading");
			const libNovel = clone(novel);
			const preDownloadedChapters = await getNovelChapters(novel);
			const novelStore = await getNovelStore(novel);
			setDownloadStatus(status => {
				status[novel.id] = {
					novel_id: novel.id,
					status: "Downloading",
					downloaded_chapters_count: preDownloadedChapters.length,
					downloaded_chapters: preDownloadedChapters,
					novelStore,
				};
			});
			const downloadOptions = appState.sourceDownloadOptions[novelSource.id]
			const result = await novelSource.downloadNovel(
				novel,
				downloadOptions.downloadBatchSize,
				downloadOptions.downloadBatchDelay,
				preDownloadedChapters.length
			);
			const chapters = [...preDownloadedChapters, ...result.chapters];
			if (result.status === "Completed") {
				const epub = await EpubTemplate.generateEpub(novel, chapters);
				await saveNovelEpub(novel, epub, appState.libraryRootPath);
				libNovel.isDownloaded = true;
				libNovel.downloadedAt = new Date().toISOString();
				libNovel.downloadState = "Completed";
			} else {
				// A cancelled download is a pause: the saved chapters let it resume later
				libNovel.downloadState = "Paused";
				setDownloadStatus((status) => {
					if (status[novel.id]) status[novel.id].status = "Paused";
				});
			}
			libNovel.downloadedChapters = chapters.length;
			saveNovel(libNovel);
			return true;
		} catch (e) {
			console.error(e);
			setNovelDownloadState(_novel.id, "Error");
			if (!quiet) await message(`${e}`, { title: `${SOURCES[_novel.source].name} : ${_novel.title}`, kind: 'error' });
			return false;
		} finally {
			activeDownloads.delete(_novel.id);
		}
	}

	// Stops the download after the current batch of chapters; it can be resumed with downloadNovel
	const pauseDownload = async (novel: NovelT) => {
		try {
			await SOURCES[novel.source].cancelDownload(novel);
		} catch (e) {
			console.error(e);
			await message(`Couldn't pause download for ${novel.title}`, { title: SOURCES[novel.source].name, kind: 'error' });
		}
	}

	return { addToLibrary, downloadNovel, pauseDownload };
}

// The library novels the queue is downloading right now
export const activeQueueNovelsAtom = atom<string[]>([]);

export function useDownloadQueue() {
	const store = useStore();
	const [appState, setAppState] = useAtom(appStateAtom);
	const { addToLibrary } = useNovelDownloader();
	const queue = appState.downloadQueue ?? [];
	const queueLimit = appState.queueLimit ?? DEFAULT_QUEUE_LIMIT;

	const updateQueue = (update: (queue: string[]) => string[]) => {
		setAppState((state) => {
			state.downloadQueue = update(state.downloadQueue ?? []);
		});
	}

	// Adds the novel to the library if needed, then to the end of the queue. Returns false if the queue is full.
	const addToQueue = async (novel: NovelT, { quiet = false } = {}) => {
		const currentQueue = store.get(appStateAtom).downloadQueue ?? [];
		if (currentQueue.includes(novel.id)) return true;
		if (currentQueue.length >= queueLimit) {
			if (!quiet) await message(`The queue is full (${queueLimit} novels). You can raise the limit in Settings.`, { title: "Download Queue", kind: 'warning' });
			return false;
		}
		try {
			const libNovel = await addToLibrary(novel);
			updateQueue((q) => q.includes(libNovel.id) || q.length >= queueLimit ? q : [...q, libNovel.id]);
		} catch (e) {
			console.error(e);
			await message(`Couldn't add ${novel.title} to the queue`, { title: SOURCES[novel.source].name, kind: 'error' });
		}
		return true;
	}

	const removeFromQueue = (novelId: string) => updateQueue((q) => q.filter((id) => id !== novelId));

	const moveInQueue = (novelId: string, offset: number) => updateQueue((q) => {
		const index = q.indexOf(novelId);
		const newIndex = index + offset;
		if (index < 0 || newIndex < 0 || newIndex >= q.length) return q;
		const newQueue = [...q];
		newQueue.splice(index, 1);
		newQueue.splice(newIndex, 0, novelId);
		return newQueue;
	});

	const clearQueue = () => updateQueue((q) => q.filter((id) => store.get(activeQueueNovelsAtom).includes(id)));

	return { queue, queueLimit, addToQueue, removeFromQueue, moveInQueue, clearQueue };
}

// Downloads queued novels in order, up to the "max concurrent downloads" setting at a time.
// Mounted once at the app root so the queue keeps going on every page.
export function DownloadQueueRunner() {
	const store = useStore();
	const appState = useAtomValue(appStateAtom);
	const docker = useAtomValue(dockerAtom);
	const setActiveQueueNovels = useSetAtom(activeQueueNovelsAtom);
	const { downloadNovel } = useNovelDownloader();
	const { removeFromQueue } = useDownloadQueue();
	const running = useRef(new Set<string>());
	const [finishedCount, setFinishedCount] = useState(0);

	useEffect(() => {
		startDownloads();
	}, [appState.downloadQueue, appState.maxConcurrentDownloads, docker, finishedCount]);

	const startDownloads = () => {
		const { downloadQueue = [], maxConcurrentDownloads = DEFAULT_MAX_CONCURRENT_DOWNLOADS } = store.get(appStateAtom);
		const { engineStatus, cfResolverStatus } = store.get(dockerAtom);
		const library = store.get(libraryStateAtom).novels;

		for (const novelId of downloadQueue) {
			if (running.current.size >= maxConcurrentDownloads) break;
			if (running.current.has(novelId)) continue;
			const novel = library[novelId];
			if (!novel) {
				removeFromQueue(novelId);
				continue;
			}
			// Novels that need the Cloudflare resolver wait for it; this runs again when the docker status changes
			if (SOURCES[novel.source].cloudflareProtected && !(engineStatus && cfResolverStatus)) continue;
			runDownload(novel);
		}
	}

	const runDownload = async (novel: NovelT) => {
		running.current.add(novel.id);
		setActiveQueueNovels([...running.current]);
		await downloadNovel(novel, { quiet: true });
		running.current.delete(novel.id);
		setActiveQueueNovels([...running.current]);
		// Finished, paused or failed, it leaves the queue and the next one starts
		removeFromQueue(novel.id);
		setFinishedCount((c) => c + 1);
	}

	return null;
}
