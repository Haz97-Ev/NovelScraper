import { CardUI, CardGridUI } from "@/components/card"
import { CloudflareResolverStatus } from "@/components/cloudflare-resolver"
import Page from '@/components/page'
import SearchBar from "@/components/search-bar"
import { Badge } from "@/components/ui/badge"
import { getUnCachedFileSrc } from "@/lib/library/library"
import { SourceIDsT, SOURCES } from '@/lib/sources/sources'
import { NovelSource } from "@/lib/sources/template"
import { NovelT } from "@/lib/sources/types"
import { activeNovelAtom, browseStateAtom, dockerAtom, downloadStatusAtom, libraryStateAtom, searchHistoryAtom } from "@/lib/store"
import { BookmarkSolid, ChevronLeft, ChevronRight, CircleDashed, DownloadSolid, ExternalLink } from "@mynaui/icons-react"
import { createFileRoute, useLocation } from '@tanstack/react-router'
import { message } from "@tauri-apps/plugin-dialog"
import { useAtom, useAtomValue, useSetAtom } from "jotai/react"
import { useEffect, useState } from 'react'
import MissingImageBanner from "@/assets/ui/missing-image-banner.jpg";
import { TooltipUI } from "@/components/tooltip"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { TinyP } from "@/components/typography"
import { isNovelDownloading, useNovelDownloader } from "@/lib/library/download"

const BROWSE_PAGE_SIZE = 20;

export const Route = createFileRoute('/sources/$sourceId')({
	component: RouteComponent,
})

function RouteComponent() {
	const { sourceId } = Route.useParams();
	const location = useLocation();

	const [source, setSource] = useState<NovelSource>();
	const [isSearching, setIsSearching] = useState(false);
	const [noSearchResultsFor, setNoSearchResultsFor] = useState<string>();
	const [searchHistory, setSearchHistory] = useAtom(searchHistoryAtom);
	const libraryState = useAtomValue(libraryStateAtom);
	const setActiveNovel = useSetAtom(activeNovelAtom);
	const docker = useAtomValue(dockerAtom);
	const downloadStatus = useAtomValue(downloadStatusAtom);
	const [browseState, setBrowseState] = useAtom(browseStateAtom);
	const [isBrowsing, setIsBrowsing] = useState(false);
	const [tab, setTab] = useState<"browse" | "search">("browse");
	const [preparingDownloads, setPreparingDownloads] = useState<string[]>([]);
	const { downloadNovel } = useNovelDownloader();

	const canBrowse = !!source && source.browseSorts.length > 0;
	const cfReady = !source?.cloudflareProtected || (docker.engineStatus && docker.cfResolverStatus);
	const sourceBrowseState = browseState[sourceId as SourceIDsT];

	useEffect(() => {
		const _source = SOURCES[sourceId as SourceIDsT];
		setSource(_source);
		setTab(_source.browseSorts.length > 0 ? "browse" : "search");
	}, [sourceId]);

	useEffect(() => {
		if (!source || !canBrowse || !cfReady || sourceBrowseState || isBrowsing) return;
		loadBrowsePage(source.browseSorts[0].id, 1);
	}, [source, cfReady]);

	// Loads source listing pages until there are enough novels to fill the requested page
	const loadBrowsePage = async (sortId: string, page: number) => {
		if (!source || isBrowsing) return;
		setIsBrowsing(true);
		try {
			const sameSort = sourceBrowseState?.sortId === sortId;
			const novels = sameSort ? [...sourceBrowseState.novels] : [];
			let sourcePagesLoaded = sameSort ? sourceBrowseState.sourcePagesLoaded : 0;
			let isExhausted = sameSort ? sourceBrowseState.isExhausted : false;

			while (!isExhausted && novels.length < page * BROWSE_PAGE_SIZE) {
				await new Promise((resolve) => setTimeout(resolve, 300));
				const pageNovels = await source.browseNovels(sortId, sourcePagesLoaded + 1);
				sourcePagesLoaded++;
				const seen = new Set(novels.map((n) => n.id));
				const newNovels = pageNovels.filter((n) => {
					if (!n.url || seen.has(n.id)) return false;
					seen.add(n.id);
					return true;
				});
				// Sites often repeat their last page past the end, so no new novels means we're done
				if (!newNovels.length) isExhausted = true;
				novels.push(...newNovels);
			}

			const lastPage = Math.max(1, Math.ceil(novels.length / BROWSE_PAGE_SIZE));
			setBrowseState((state) => {
				state[sourceId as SourceIDsT] = {
					sortId,
					novels,
					sourcePagesLoaded,
					isExhausted,
					page: Math.min(page, lastPage),
				};
			});
		} catch (e) {
			console.error(e);
			await message("Couldn't load novels!", { title: source.name, kind: 'error' });
		}
		setIsBrowsing(false);
	}

	const handleQuickDownload = async (novel: NovelT) => {
		if (preparingDownloads.includes(novel.id)) return;
		setPreparingDownloads((ids) => [...ids, novel.id]);
		await downloadNovel(novel);
		setPreparingDownloads((ids) => ids.filter((id) => id !== novel.id));
	}

	const handleSearch = async (query: string) => {
		if (!source || !query || isSearching) return;
		try {
			setIsSearching(true);
			setTab("search");
			setNoSearchResultsFor(undefined);
			await new Promise((resolve) => setTimeout(resolve, 500));
			let searchedNovels = await source.searchNovels(query);
			if (!searchedNovels.length) setNoSearchResultsFor(query);
			searchedNovels = searchedNovels.map((n: NovelT) => libraryState.novels[n.id] ?? n);
			setSearchHistory((state) => {
				let novels = state[sourceId as SourceIDsT];
				searchedNovels.forEach((n: NovelT) => {
					novels = novels.filter((n2) => n2.id !== n.id)
				});
				novels.unshift(...searchedNovels);
				return {
					...state,
					[sourceId as SourceIDsT]: novels,
				};
			});
		} catch (e) {
			console.error(e);
			await message("Couldn't search for novels!", { title: 'NovelScraper Library', kind: 'error' });
		}
		setIsSearching(false);
	}

	const handleClear = () => {
		setNoSearchResultsFor(undefined);
		// setSearchHistory((state) => {
		// 	state[sourceId as SourceIDsT] = [];
		// });
	}

	const handleOpenInBrowser = async () => {
		if (!source?.url) return;
		try {
			await openUrl(source.url);
		} catch (e) {
			console.error(e);
			await message(`Couldn't open ${source.url} in browser`, { title: "Error", kind: 'error' });
		}
	}

	const renderNovelCard = (_novel: NovelT) => {
		if (!source) return null;
		const novel = libraryState.novels[_novel.id] ?? _novel;
		const status = downloadStatus[novel.id];
		const isDownloading = status?.status === "Downloading"
			|| preparingDownloads.includes(novel.id)
			|| isNovelDownloading(novel.id);

		let coverSrc = novel.coverURL ?? novel.thumbnailURL ?? "";
		if (source.cloudflareProtected) coverSrc = MissingImageBanner; // test.jpg
		if (novel.isInLibrary && novel.localCoverPath) coverSrc = getUnCachedFileSrc(novel.localCoverPath);

		return <CardUI
			key={novel.id}
			href={`/novel?fromRoute=${location.pathname}`}
			imageURL={coverSrc}
			title={novel.title}
			subTitle={novel.authors.join(', ')}
			badges={[
				novel.isInLibrary ?
					<Badge className="text-green-900 p-0">
						<BookmarkSolid width={20} />
					</Badge>
					: null,
			]}
			action={
				<TooltipUI content={isDownloading ? "Downloading" : "Download"} side="bottom">
					<Button
						size="icon"
						className="size-8"
						disabled={isDownloading || !cfReady}
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							handleQuickDownload(novel);
						}}
					>
						{isDownloading ? <CircleDashed className="animate-spin" /> : <DownloadSolid />}
					</Button>
				</TooltipUI>
			}
			footer={status &&
				<div className="flex flex-col gap-1">
					<div className="flex justify-between">
						<TinyP>{status.status}</TinyP>
						<TinyP>{status.downloaded_chapters_count} / {novel.totalChapters ?? "?"}</TinyP>
					</div>
					<Progress value={((status.downloaded_chapters_count || 0) / (novel.totalChapters || 1)) * 100} />
				</div>
			}
			onClick={() => setActiveNovel(novel)}
		/>
	}

	const renderSearchResults = () => (
		<CardGridUI>
			{searchHistory[sourceId as SourceIDsT].map(renderNovelCard)}
		</CardGridUI>
	)

	const renderBrowse = () => {
		if (!source) return null;
		const sortId = sourceBrowseState?.sortId ?? source.browseSorts[0].id;
		const page = sourceBrowseState?.page ?? 1;
		const novels = sourceBrowseState?.novels ?? [];
		const pageNovels = novels.slice((page - 1) * BROWSE_PAGE_SIZE, page * BROWSE_PAGE_SIZE);
		const hasNextPage = !!sourceBrowseState && (!sourceBrowseState.isExhausted || novels.length > page * BROWSE_PAGE_SIZE);
		const disabled = isBrowsing || !cfReady;

		const pagination = <div className="flex items-center justify-between gap-2">
			<div className="flex gap-2">
				{source.browseSorts.map((sort) =>
					<Button
						key={sort.id}
						size="sm"
						variant={sort.id === sortId ? "default" : "secondary"}
						disabled={disabled}
						onClick={() => loadBrowsePage(sort.id, 1)}
					>{sort.label}</Button>
				)}
			</div>
			<div className="flex items-center gap-2">
				{isBrowsing && <CircleDashed className="size-4 animate-spin text-primary" />}
				<Button size="icon" variant="secondary" disabled={disabled || page <= 1} onClick={() => loadBrowsePage(sortId, page - 1)}>
					<ChevronLeft />
				</Button>
				<TinyP>Page {page}</TinyP>
				<Button size="icon" variant="secondary" disabled={disabled || !hasNextPage} onClick={() => loadBrowsePage(sortId, page + 1)}>
					<ChevronRight />
				</Button>
			</div>
		</div>

		return <>
			{pagination}
			{!cfReady && !sourceBrowseState && <TinyP className="text-muted-foreground">Novels will load once the Cloudflare resolver is running.</TinyP>}
			<CardGridUI>
				{pageNovels.map(renderNovelCard)}
			</CardGridUI>
			{pageNovels.length > 0 && pagination}
		</>
	}

	if (!source) return <></>
	return (
		<Page titleBarContent={<TooltipUI content="Open in Browser" side="bottom" sideOffset={8}>
			<Button variant="secondary" className="text-xs" onClick={handleOpenInBrowser}>
				<ExternalLink className="size-4" />
			</Button>
		</TooltipUI>}>
			{source.cloudflareProtected && <CloudflareResolverStatus />}
			<SearchBar
				handleSearch={handleSearch}
				handleClear={handleClear}
				loading={isSearching}
				disabled={!cfReady}
			/>

			<div className={`border p-2 px-3 rounded-md bg-yellow-300 text-yellow-900 font-medium overflow-hidden transition-all ${noSearchResultsFor ? "" : "h-0 !p-0 border-none -mt-5"}`}>
				No results found for <b>{noSearchResultsFor}</b>
			</div>

			{canBrowse ? <Tabs value={tab} onValueChange={(value) => setTab(value as "browse" | "search")}>
				<TabsList>
					<TabsTrigger value="browse">Browse</TabsTrigger>
					<TabsTrigger value="search">Search Results</TabsTrigger>
				</TabsList>
				<TabsContent value="browse" className="flex flex-col gap-4">
					{renderBrowse()}
				</TabsContent>
				<TabsContent value="search">
					{renderSearchResults()}
				</TabsContent>
			</Tabs> : renderSearchResults()}
		</Page>
	)
}
