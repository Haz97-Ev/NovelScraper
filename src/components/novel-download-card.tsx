import { ReactNode, useState } from "react";
import { useAtomValue } from "jotai/react";
import { CircleDashed, DownloadSolid, ListNumber, PauseSolid, PlaySolid, XSquareSolid } from "@mynaui/icons-react";
import { CardUI } from "./card";
import { TooltipUI } from "./tooltip";
import { TinyP } from "./typography";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { NovelT } from "@/lib/sources/types";
import { appStateAtom, downloadStatusAtom } from "@/lib/store";
import { activeQueueNovelsAtom, isNovelDownloading, isNovelFullyDownloaded, useDownloadQueue, useNovelDownloader } from "@/lib/library/download";

type NovelDownloadCardProps = {
	novel: NovelT;
	href: string;
	imageURL: string;
	subTitle: string;
	badges?: ReactNode[];
	disabled?: boolean;
	onClick?: () => void;
}
// A novel card with download, pause/resume and queue buttons, plus a saved progress bar
export function NovelDownloadCard({ novel, href, imageURL, subTitle, badges, disabled = false, onClick }: NovelDownloadCardProps) {
	const appState = useAtomValue(appStateAtom);
	const downloadStatus = useAtomValue(downloadStatusAtom)[novel.id];
	const activeQueueNovels = useAtomValue(activeQueueNovelsAtom);
	const { downloadNovel, pauseDownload } = useNovelDownloader();
	const { addToQueue, removeFromQueue } = useDownloadQueue();
	const [isPreparing, setIsPreparing] = useState(false);

	const isDownloading = downloadStatus?.status === "Downloading";
	const isBusy = isPreparing || isDownloading || isNovelDownloading(novel.id) || activeQueueNovels.includes(novel.id);
	const queuePosition = (appState.downloadQueue ?? []).indexOf(novel.id);
	const isQueued = queuePosition >= 0 && !activeQueueNovels.includes(novel.id);
	const canResume = novel.downloadState === "Paused" || (novel.downloadedChapters > 0 && !isNovelFullyDownloaded(novel));

	const handleDownload = async () => {
		setIsPreparing(true);
		await downloadNovel(novel);
		setIsPreparing(false);
	}

	const handleQueue = async () => {
		if (isQueued) return removeFromQueue(novel.id);
		setIsPreparing(true);
		await addToQueue(novel);
		setIsPreparing(false);
	}

	const stop = (e: React.MouseEvent, fn: () => void) => {
		e.preventDefault();
		e.stopPropagation();
		fn();
	}

	const action = <div className="flex gap-1">
		{isDownloading ?
			<TooltipUI content="Pause" side="bottom">
				<Button size="icon" className="size-8" variant="destructive" onClick={(e) => stop(e, () => pauseDownload(novel))}>
					<PauseSolid />
				</Button>
			</TooltipUI>
			:
			<TooltipUI content={isBusy ? "Starting" : canResume ? "Resume" : "Download"} side="bottom">
				<Button size="icon" className="size-8" disabled={isBusy || disabled} onClick={(e) => stop(e, handleDownload)}>
					{isBusy ? <CircleDashed className="animate-spin" /> : canResume ? <PlaySolid /> : <DownloadSolid />}
				</Button>
			</TooltipUI>
		}
		{!isBusy && <TooltipUI content={isQueued ? "Remove from Queue" : "Add to Queue"} side="bottom">
			<Button size="icon" className="size-8" variant="secondary" disabled={!isQueued && disabled} onClick={(e) => stop(e, handleQueue)}>
				{isQueued ? <XSquareSolid /> : <ListNumber />}
			</Button>
		</TooltipUI>}
	</div>

	const downloadedCount = downloadStatus?.downloaded_chapters_count ?? novel.downloadedChapters;
	const totalChapters = novel.totalChapters || 0;
	let label: string | undefined;
	if (isDownloading) label = "Downloading";
	else if (isQueued) label = `Queued #${queuePosition + 1}`;
	else if (novel.downloadState === "Error") label = "Error";
	else if (novel.downloadState === "Paused") label = "Paused";
	else if (isNovelFullyDownloaded(novel)) label = "Downloaded";
	else if (novel.downloadedChapters > 0) label = "Partly downloaded";

	const footer = label &&
		<div className="flex flex-col gap-1">
			<div className="flex justify-between">
				<TinyP>{label}</TinyP>
				<TinyP>{downloadedCount} / {totalChapters || "?"}</TinyP>
			</div>
			<Progress value={totalChapters ? Math.min(100, (downloadedCount / totalChapters) * 100) : 0} />
		</div>

	return <CardUI
		href={href}
		imageURL={imageURL}
		title={novel.title}
		subTitle={subTitle}
		badges={badges}
		action={action}
		footer={footer}
		onClick={onClick}
	/>
}
