import { useAtomValue, useSetAtom, useStore } from "jotai/react";
import clone from "clone";
import { message } from "@tauri-apps/plugin-dialog";
import { SourceIDsT, SOURCES } from "../sources/sources";
import { NovelT } from "../sources/types";
import { activeNovelAtom, appStateAtom, downloadStatusAtom, libraryStateAtom, searchHistoryAtom } from "../store";
import { fetchMetadataForNovel, getNovelChapters, getNovelStore, saveNovelCover, saveNovelEpub } from "./library";
import EpubTemplate from "./epub";

// Novels currently being prepared or downloaded, so a second click can't start a duplicate download
const activeDownloads = new Set<string>();

export const isNovelDownloading = (novelId: string) => activeDownloads.has(novelId);

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

	// Downloads a novel, adding it to the library first if it isn't there yet
	const downloadNovel = async (_novel: NovelT) => {
		if (activeDownloads.has(_novel.id)) return;
		if (store.get(downloadStatusAtom)[_novel.id]?.status === "Downloading") return;
		activeDownloads.add(_novel.id);
		try {
			const novel = await addToLibrary(_novel);
			const novelSource = SOURCES[novel.source];
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
			}
			libNovel.downloadedChapters = chapters.length;
			saveNovel(libNovel);
		} catch (e) {
			console.error(e);
			await message(`${e}`, { title: `${SOURCES[_novel.source].name} : ${_novel.title}`, kind: 'error' });
		} finally {
			activeDownloads.delete(_novel.id);
		}
	}

	return { addToLibrary, downloadNovel };
}
