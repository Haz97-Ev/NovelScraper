import { CardGridUI, NovelUpdatingBadge, RemainingChaptersBadge } from "@/components/card";
import { NovelDownloadCard } from "@/components/novel-download-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { SmallP, TinyP } from "@/components/typography";
import { activeQueueNovelsAtom, isNovelCompleted, isNovelFullyDownloaded, useDownloadQueue } from "@/lib/library/download";
import { CloudflareResolverStatus } from "@/components/cloudflare-resolver";
import Page from '@/components/page';
import SearchBar from "@/components/search-bar";
import { TooltipUI } from "@/components/tooltip";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { fetchMetadataForNovels, getUnCachedFileSrc } from "@/lib/library/library";
import { SOURCES } from "@/lib/sources/sources";
import { activeNovelAtom, appStateAtom, dockerAtom, downloadStatusAtom, libraryFiltersAtom, LibraryFiltersT, libraryStateAtom } from "@/lib/store";
import { ArrowDown, ArrowUp, RefreshSolid } from "@mynaui/icons-react";
import { createFileRoute } from '@tanstack/react-router'
import { message } from "@tauri-apps/plugin-dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai/react";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute('/library')({
	component: RouteComponent,
})

function RouteComponent() {
	const [libraryState, setLibraryState] = useAtom(libraryStateAtom);
	const setActiveNovel = useSetAtom(activeNovelAtom);
	const [searchQuery, setSearchQuery] = useState("");
	const [filters, setFilters] = useAtom(libraryFiltersAtom);
	const [isCFAlertOpen, setIsCFAlertOpen] = useState(false);
	const [docker, setDocker] = useAtom(dockerAtom);
	const [tab, setTab] = useState<"novels" | "queue">("novels");
	const { queue, queueLimit, addToQueue, removeFromQueue, moveInQueue, clearQueue } = useDownloadQueue();
	const activeQueueNovels = useAtomValue(activeQueueNovelsAtom);
	const downloadStatus = useAtomValue(downloadStatusAtom);
	const appState = useAtomValue(appStateAtom);

	const filteredNovels = Object.values(libraryState.novels).filter((novel) => {
		if (searchQuery && !novel.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
		if (filters.status === "completed" && !isNovelCompleted(novel)) return false;
		if (filters.status === "ongoing" && isNovelCompleted(novel)) return false;
		if (filters.download === "downloaded" && !isNovelFullyDownloaded(novel)) return false;
		if (filters.download === "partial" && (novel.downloadedChapters <= 0 || isNovelFullyDownloaded(novel))) return false;
		if (filters.download === "not-downloaded" && novel.downloadedChapters > 0) return false;
		return true;
	});
	const unfinishedNovels = Object.values(libraryState.novels).filter((novel) => !isNovelFullyDownloaded(novel));

	useEffect(() => {
		if (isCFAlertOpen && docker.engineStatus && docker.cfResolverStatus) {
			setIsCFAlertOpen(false);
			handleCheckForUpdates();
		}
	}, [isCFAlertOpen, docker]);

	const handleSearch = async (query: string) => {
		setSearchQuery(query);
	}

	const handleClear = () => {
		setSearchQuery("");
	}

	const handleQueueUnfinished = async () => {
		for (const novel of unfinishedNovels) {
			if (!await addToQueue(novel, { quiet: true })) {
				await message(`The queue is full (${queueLimit} novels), so some novels weren't added. You can raise the limit in Settings.`, { title: "Download Queue", kind: 'warning' });
				break;
			}
		}
		setTab("queue");
	}

	const renderFilterButtons = <T extends string>(options: [T, string][], value: T, onChange: (value: T) => void) => (
		<div className="flex gap-1">
			{options.map(([option, label]) =>
				<Button key={option} size="sm" variant={option === value ? "default" : "secondary"} onClick={() => onChange(option)}>{label}</Button>
			)}
		</div>
	)

	const renderNovels = () => <>
		<div className="flex flex-wrap items-center justify-between gap-2">
			{renderFilterButtons<LibraryFiltersT["status"]>(
				[["all", "All"], ["completed", "Completed"], ["ongoing", "Ongoing"]],
				filters.status,
				(status) => setFilters((f) => { f.status = status; }),
			)}
			{renderFilterButtons<LibraryFiltersT["download"]>(
				[["all", "Any"], ["downloaded", "Downloaded"], ["partial", "Partly downloaded"], ["not-downloaded", "Not downloaded"]],
				filters.download,
				(download) => setFilters((f) => { f.download = download; }),
			)}
		</div>
		{filteredNovels.length === 0 && <TinyP className="text-muted-foreground">No novels match these filters.</TinyP>}
		<CardGridUI>
			{filteredNovels.map((novel) => {
				let coverSrc = novel.coverURL ?? novel.thumbnailURL ?? "";
				if (novel.localCoverPath) coverSrc = getUnCachedFileSrc(novel.localCoverPath);
				const remainingChapters = (novel.totalChapters || 0) - novel.downloadedChapters;
				const cfReady = !SOURCES[novel.source].cloudflareProtected || (docker.engineStatus && docker.cfResolverStatus);

				return <NovelDownloadCard
					key={novel.id}
					novel={novel}
					href={`/novel?fromRoute=${location.pathname}`}
					imageURL={coverSrc}
					subTitle={`${SOURCES[novel.source].name} · ${isNovelCompleted(novel) ? "Completed" : "Ongoing"}`}
					onClick={() => setActiveNovel(novel)}
					disabled={!cfReady}
					badges={[
						NovelUpdatingBadge({ isUpdating: novel.isUpdating }),
						RemainingChaptersBadge({ remainingChapters }),
					]}
				/>
			})}
		</CardGridUI>
	</>

	const renderQueue = () => <div className="flex flex-col gap-3">
		<div className="flex flex-wrap items-center justify-between gap-2">
			<TinyP className="text-muted-foreground">
				{queue.length} / {queueLimit} queued. Novels download in order, {appState.maxConcurrentDownloads ?? 1} at a time (change this in Settings). Pausing a novel takes it out of the queue.
			</TinyP>
			<div className="flex gap-2">
				<Button size="sm" variant="secondary" onClick={handleQueueUnfinished} disabled={!unfinishedNovels.length}>
					Queue all unfinished ({unfinishedNovels.length})
				</Button>
				<Button size="sm" variant="destructive" onClick={clearQueue} disabled={!queue.length}>Clear queue</Button>
			</div>
		</div>
		{queue.some((id) => libraryState.novels[id] && SOURCES[libraryState.novels[id].source].cloudflareProtected) && <CloudflareResolverStatus />}
		{queue.length === 0 && <TinyP className="text-muted-foreground">The queue is empty. Use the queue button on a novel to add it.</TinyP>}
		{queue.map((novelId, i) => {
			const novel = libraryState.novels[novelId];
			if (!novel) return null;
			const isActive = activeQueueNovels.includes(novelId);
			const count = downloadStatus[novelId]?.downloaded_chapters_count ?? novel.downloadedChapters;
			const total = novel.totalChapters || 0;
			return <div key={novelId} className="flex items-center gap-3 rounded-lg border bg-card p-2 px-3">
				<TinyP className="w-6 text-muted-foreground">{i + 1}</TinyP>
				<div className="flex flex-1 flex-col gap-1 overflow-hidden">
					<div className="flex justify-between gap-2">
						<SmallP className="text-ellipsis text-nowrap overflow-hidden">{novel.title}</SmallP>
						<TinyP className="text-nowrap">{isActive ? "Downloading" : "Waiting"} · {count} / {total || "?"}</TinyP>
					</div>
					<Progress value={total ? Math.min(100, (count / total) * 100) : 0} />
				</div>
				<div className="flex gap-1">
					<Button size="icon" variant="secondary" className="size-8" disabled={isActive || i === 0} onClick={() => moveInQueue(novelId, -1)}><ArrowUp /></Button>
					<Button size="icon" variant="secondary" className="size-8" disabled={isActive || i === queue.length - 1} onClick={() => moveInQueue(novelId, 1)}><ArrowDown /></Button>
					<Button size="icon" variant="destructive" className="size-8" disabled={isActive} onClick={() => removeFromQueue(novelId)}><XIcon /></Button>
				</div>
			</div>
		})}
	</div>

	const handleCheckForUpdates = async () => {
		try {
			const novels = Object.values(libraryState.novels).filter(novel => !novel.isUpdating);
			if (novels.some(novel => SOURCES[novel.source].cloudflareProtected) && (!docker.engineStatus || !docker.cfResolverStatus)) {
				setIsCFAlertOpen(true);
				return;
			}

			setLibraryState((state) => {
				for (const novel of novels) {
					state.novels[novel.id].isUpdating = true;
				}
			});
			const updatedNovels = await fetchMetadataForNovels(novels);
			setLibraryState((state) => {
				for (const novel of updatedNovels) {
					novel.isUpdating = false;
					state.novels[novel.id] = novel;
				}
			});
		} catch (e) {
			console.error(e);
			await message(`Couldn't check for updates`, { title: "NovelScraper", kind: 'error' });
		}
	}

	return (
		<Page
			titleBarContent={
				<Button size="sm" variant="secondary" onClick={handleCheckForUpdates}>
					<RefreshSolid />
					Update Library
				</Button>
			}
		>
			<SearchBar
				handleSearch={handleSearch}
				handleClear={handleClear}
				searchOnType
			/>
			<Tabs value={tab} onValueChange={(value) => setTab(value as "novels" | "queue")}>
				<TabsList>
					<TabsTrigger value="novels">Novels</TabsTrigger>
					<TabsTrigger value="queue">Queue{queue.length ? ` (${queue.length})` : ""}</TabsTrigger>
				</TabsList>
				<TabsContent value="novels" className="flex flex-col gap-4">
					{renderNovels()}
				</TabsContent>
				<TabsContent value="queue">
					{renderQueue()}
				</TabsContent>
			</Tabs>

			<AlertDialog open={isCFAlertOpen} onOpenChange={setIsCFAlertOpen}>
				{/* <AlertDialogTrigger>Open</AlertDialogTrigger> */}
				<AlertDialogContent>
					<AlertDialogHeader className="relative">
						<AlertDialogTitle>Cloudflare Resolver is offline</AlertDialogTitle>
						<AlertDialogDescription>
							Some of the novels in your library require a Cloudflare resolver to fetch metadata. Please start the Cloudflare resolver to continue.
						</AlertDialogDescription>
						<Button size="icon" variant="secondary" className="absolute -top-2 -right-2 p-0 w-6 h-6" onClick={() => setIsCFAlertOpen(false)}><XIcon /></Button>
					</AlertDialogHeader>
					<AlertDialogFooter className="flex !justify-between">
						<CloudflareResolverStatus />
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Page>
	);
}
