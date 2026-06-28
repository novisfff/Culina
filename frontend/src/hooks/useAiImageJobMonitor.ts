import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { invalidateAfterAiImageJobChanged, invalidateAfterSearchIndexJobChanged } from '../api/cacheInvalidation';
import { queryKeys } from '../api/queryKeys';
import type { AiRenderResponse, SearchIndexJobResponse } from '../api/types';
import type { AppNotificationJob } from '../app/AppShell';
import { readJsonStorage, writeJsonStorage } from '../lib/storage';
import type { NoticeState } from './useNotice';

const TARGET_LABELS: Record<string, string> = {
  food: '食物',
  ingredient: '食材',
  recipe: '菜谱',
  food_scene: '食物场景',
  meal_log: '餐食记录',
  user: '头像',
  family: '家庭图',
};

const DISMISSED_AI_IMAGE_JOB_KEY = 'culina-dismissed-ai-image-jobs-v1';

type RetryNotificationResult =
  | { kind: 'image'; job: AiRenderResponse }
  | { kind: 'search-index'; job: SearchIndexJobResponse };

function imageNotificationId(jobId: string) {
  return `image:${jobId}`;
}

function searchIndexNotificationId(jobId: string) {
  return `search-index:${jobId}`;
}

function isTerminalStatus(status: AppNotificationJob['status']) {
  return status === 'succeeded' || status === 'failed';
}

function isTerminalImageJob(job: AiRenderResponse) {
  return job.status === 'succeeded' || job.status === 'failed';
}

function isTerminalSearchIndexJob(job: SearchIndexJobResponse) {
  return job.status === 'succeeded' || job.status === 'failed';
}

function buildImageJobNotice(job: AiRenderResponse): NoticeState {
  const targetLabel = job.target_entity_type ? TARGET_LABELS[job.target_entity_type] ?? '图片' : '图片';
  if (job.status === 'failed') {
    return {
      tone: 'danger',
      title: 'AI 图片生成失败',
      message: job.error || `${targetLabel}主图没有生成成功，可以稍后重试。`,
    };
  }
  if (job.bind_status === 'skipped') {
    return {
      tone: 'warning',
      title: 'AI 图片已生成',
      message: `${targetLabel}已有新图片，已保留生成图但没有替换当前图片。`,
    };
  }
  if (job.bind_status === 'bound') {
    return {
      tone: 'success',
      title: 'AI 图片已更新',
      message: `${targetLabel}主图已生成并自动更新。`,
    };
  }
  return {
    tone: 'success',
    title: 'AI 图片已生成',
    message: `${targetLabel}主图已生成，可以在图片资产中继续使用。`,
  };
}

function buildSearchIndexJobNotice(job: SearchIndexJobResponse): NoticeState {
  const targetLabel = SEARCH_TARGET_LABELS[job.entity_type] ?? '资料';
  if (job.status === 'failed') {
    return {
      tone: 'danger',
      title: '索引更新失败',
      message: job.error || `${targetLabel}没有完成索引更新，可以稍后重试。`,
    };
  }
  return {
    tone: 'success',
    title: '索引已更新',
    message: `${targetLabel}已经可以用于搜索和 AI 召回。`,
  };
}

const SEARCH_TARGET_LABELS: Record<string, string> = {
  food: '食物',
  ingredient: '食材',
  recipe: '菜谱',
};

function buildImageNotificationJob(job: AiRenderResponse): AppNotificationJob | null {
  if (!job.job_id) return null;
  const targetLabel = job.target_entity_type ? TARGET_LABELS[job.target_entity_type] ?? '图片' : '图片';
  const targetName = job.target_entity_name?.trim();
  let statusLabel = '已生成';
  let description = '生成图已保留在图片资产中';
  if (job.status === 'queued') {
    statusLabel = '正在处理';
    description = '已加入队列，稍后开始生成';
  } else if (job.status === 'running') {
    statusLabel = '正在处理';
    description = '正在生成图片，可以先处理其他内容';
  } else if (job.status === 'failed') {
    statusLabel = '失败';
    description = job.error?.trim() || '生成失败，可以直接重试';
  } else if (job.bind_status === 'skipped') {
    statusLabel = '已生成，未替换';
    description = '已有用户图片，生成图已保留';
  } else if (job.bind_status === 'bound') {
    statusLabel = '已更新';
    description = '主图已自动更新';
  }
  return {
    notification_id: imageNotificationId(job.job_id),
    task_id: job.job_id,
    kind: 'image',
    status: job.status,
    title: targetName ? `${targetName}的${targetLabel}图片生成` : `${targetLabel}图片生成`,
    status_label: statusLabel,
    description,
    can_retry: job.status === 'failed',
    can_dismiss: isTerminalImageJob(job),
  };
}

function buildSearchIndexNotificationJob(job: SearchIndexJobResponse): AppNotificationJob {
  const targetLabel = SEARCH_TARGET_LABELS[job.entity_type] ?? '资料';
  const targetName = job.target_name?.trim();
  let statusLabel = '已更新';
  let description = job.vector_status === 'indexed' ? '全文索引和向量索引已更新' : '全文索引已更新';
  if (job.status === 'queued') {
    statusLabel = '正在处理';
    description = '已加入队列，稍后更新搜索索引';
  } else if (job.status === 'running') {
    statusLabel = '正在处理';
    description = '正在更新搜索索引和可用的向量索引';
  } else if (job.status === 'failed') {
    statusLabel = '失败';
    description = job.error?.trim() || '索引更新失败，可以直接重试';
  }
  return {
    notification_id: searchIndexNotificationId(job.job_id),
    task_id: job.job_id,
    kind: 'search_index',
    status: job.status,
    title: targetName ? `${targetName}的${targetLabel}索引更新` : `${targetLabel}索引更新`,
    status_label: statusLabel,
    description,
    can_retry: job.status === 'failed',
    can_dismiss: isTerminalSearchIndexJob(job),
  };
}

export function useAiImageJobMonitor(enabled: boolean, options: { onNotice?: (notice: NoticeState) => void } = {}) {
  const { onNotice } = options;
  const queryClient = useQueryClient();
  const handledJobsRef = useRef<Set<string>>(new Set());
  const previousStatusesRef = useRef<Map<string, AppNotificationJob['status']>>(new Map());
  const initializedRef = useRef(false);
  const [dismissedJobIds, setDismissedJobIds] = useState<Set<string>>(() => new Set(readJsonStorage<string[]>(DISMISSED_AI_IMAGE_JOB_KEY, [])));
  const activeJobsQuery = useQuery({
    queryKey: queryKeys.aiImageJobs,
    queryFn: api.getActiveAiRenderJobs,
    enabled,
    refetchInterval: enabled ? 3000 : false,
  });
  const activeSearchIndexJobsQuery = useQuery({
    queryKey: queryKeys.searchIndexJobs,
    queryFn: api.getActiveSearchIndexJobs,
    enabled,
    refetchInterval: enabled ? 3000 : false,
  });
  const retryJobMutation = useMutation<RetryNotificationResult, Error, string>({
    mutationFn: (notificationId: string) => {
      const [kind, taskId] = notificationId.split(':', 2);
      if (kind === 'search-index') {
        return api.retrySearchIndexJob(taskId).then((job) => ({ kind: 'search-index' as const, job }));
      }
      return api.retryAiRenderJob(taskId).then((job) => ({ kind: 'image' as const, job }));
    },
    onSuccess: (retriedJob) => {
      const notificationId =
        retriedJob.kind === 'search-index' ? searchIndexNotificationId(retriedJob.job.job_id) : retriedJob.job.job_id ? imageNotificationId(retriedJob.job.job_id) : null;
      if (notificationId) {
        handledJobsRef.current.delete(notificationId);
        previousStatusesRef.current.set(notificationId, retriedJob.job.status);
        setDismissedJobIds((current) => {
          if (!current.has(notificationId)) {
            return current;
          }
          const next = new Set(current);
          next.delete(notificationId);
          writeJsonStorage(DISMISSED_AI_IMAGE_JOB_KEY, Array.from(next));
          return next;
        });
      }
      if (retriedJob.kind === 'search-index') {
        queryClient.setQueryData<SearchIndexJobResponse[]>(queryKeys.searchIndexJobs, (current) => {
          const jobs = current ?? [];
          if (jobs.some((job) => job.job_id === retriedJob.job.job_id)) {
            return jobs.map((job) => (job.job_id === retriedJob.job.job_id ? retriedJob.job : job));
          }
          return [retriedJob.job, ...jobs];
        });
        void activeSearchIndexJobsQuery.refetch();
      } else if (retriedJob.job.job_id) {
        queryClient.setQueryData<AiRenderResponse[]>(queryKeys.aiImageJobs, (current) => {
          const jobs = current ?? [];
          if (!retriedJob.job.job_id) {
            return jobs;
          }
          if (jobs.some((job) => job.job_id === retriedJob.job.job_id)) {
            return jobs.map((job) => (job.job_id === retriedJob.job.job_id ? retriedJob.job : job));
          }
          return [retriedJob.job, ...jobs];
        });
        void activeJobsQuery.refetch();
      }
    },
    onError: (reason) => {
      onNotice?.({
        tone: 'danger',
        title: '重试失败',
        message: reason instanceof Error && reason.message ? reason.message : '后台任务没有重新提交成功，请稍后再试。',
      });
    },
  });

  useEffect(() => {
    if (!activeJobsQuery.data && !activeSearchIndexJobsQuery.data) {
      return;
    }
    (activeJobsQuery.data ?? []).forEach((job) => {
      if (!job.job_id) return;
      const notificationId = imageNotificationId(job.job_id);
      if (handledJobsRef.current.has(notificationId)) {
        return;
      }
      if (job.status === 'succeeded' || job.status === 'failed') {
        handledJobsRef.current.add(notificationId);
        invalidateAfterAiImageJobChanged(queryClient, job);
        const previousStatus = previousStatusesRef.current.get(notificationId);
        if ((initializedRef.current && !previousStatus) || (previousStatus && previousStatus !== job.status)) {
          onNotice?.(buildImageJobNotice(job));
        }
      }
      previousStatusesRef.current.set(notificationId, job.status);
    });
    (activeSearchIndexJobsQuery.data ?? []).forEach((job) => {
      const notificationId = searchIndexNotificationId(job.job_id);
      if (handledJobsRef.current.has(notificationId)) {
        return;
      }
      if (job.status === 'succeeded' || job.status === 'failed') {
        handledJobsRef.current.add(notificationId);
        invalidateAfterSearchIndexJobChanged(queryClient, job);
        const previousStatus = previousStatusesRef.current.get(notificationId);
        if ((initializedRef.current && !previousStatus) || (previousStatus && previousStatus !== job.status)) {
          onNotice?.(buildSearchIndexJobNotice(job));
        }
      }
      previousStatusesRef.current.set(notificationId, job.status);
    });
    initializedRef.current = true;
  }, [activeJobsQuery.data, activeSearchIndexJobsQuery.data, onNotice, queryClient]);

  const dismissJob = useCallback((notificationId: string) => {
    const visibleJob = [
      ...(activeJobsQuery.data ?? []).map(buildImageNotificationJob).filter((job): job is AppNotificationJob => job !== null),
      ...(activeSearchIndexJobsQuery.data ?? []).map(buildSearchIndexNotificationJob),
    ].find((item) => item.notification_id === notificationId);
    if (!visibleJob || !isTerminalStatus(visibleJob.status)) {
      return;
    }
    setDismissedJobIds((current) => {
      if (current.has(notificationId)) {
        return current;
      }
      const next = new Set(current);
      next.add(notificationId);
      writeJsonStorage(DISMISSED_AI_IMAGE_JOB_KEY, Array.from(next));
      return next;
    });
  }, [activeJobsQuery.data, activeSearchIndexJobsQuery.data]);

  const retryJob = useCallback((notificationId: string) => {
    void retryJobMutation.mutateAsync(notificationId).catch(() => undefined);
  }, [retryJobMutation]);

  const visibleJobs = useMemo(
    () => [
      ...(activeJobsQuery.data ?? []).map(buildImageNotificationJob).filter((job): job is AppNotificationJob => job !== null),
      ...(activeSearchIndexJobsQuery.data ?? []).map(buildSearchIndexNotificationJob),
    ].filter((job) => !job.can_dismiss || !dismissedJobIds.has(job.notification_id)),
    [activeJobsQuery.data, activeSearchIndexJobsQuery.data, dismissedJobIds]
  );

  return {
    jobs: visibleJobs,
    isLoading: activeJobsQuery.isLoading || activeSearchIndexJobsQuery.isLoading,
    dismissJob,
    retryJob,
    retryingJobId: retryJobMutation.isPending ? retryJobMutation.variables ?? null : null,
  };
}
