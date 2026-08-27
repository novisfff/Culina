import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { invalidateAfterAiImageJobChanged, invalidateAfterSearchIndexJobChanged } from '../api/cacheInvalidation';
import { queryKeys } from '../api/queryKeys';
import type { AiRenderResponse, SearchIndexJobResponse } from '../api/types';
import type { BackgroundTaskNotification } from '../app/appNotificationModel';
import { readJsonStorage, writeJsonStorage } from '../lib/storage';
import type { NoticeState } from './useNotice';

const TARGET_LABELS: Record<string, string> = {
  food: '食物',
  ingredient: '食材',
  recipe: '菜谱',
  food_scene: '食物场景',
  meal_log: '餐食记录',
  user: '头像',
  family: '家庭头像',
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

function isTerminalImageJob(job: AiRenderResponse) {
  return job.status === 'succeeded' || job.status === 'failed';
}

function isTerminalSearchIndexJob(job: SearchIndexJobResponse) {
  return job.status === 'succeeded' || job.status === 'failed' || job.status === 'budget_blocked';
}

function isModelUsageLimitCode(errorCode: string | null | undefined) {
  return errorCode === 'model_usage_budget_exceeded' || errorCode === 'model_usage_capability_limit_exceeded';
}

function buildImageJobNotice(job: AiRenderResponse): NoticeState {
  const targetLabel = job.target_entity_type ? TARGET_LABELS[job.target_entity_type] ?? '图片' : '图片';
  if (job.status === 'failed') {
    return {
      tone: 'danger',
      title: 'AI 图片生成失败',
      message: job.error || (job.can_retry
        ? `${targetLabel}主图没有生成成功，可以稍后重试。`
        : `${targetLabel}主图没有生成成功；为避免重复生成，当前不能直接重试。`),
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
    message: `${targetLabel}主图已生成，可以在对应页面继续使用。`,
  };
}

function buildSearchIndexJobNotice(job: SearchIndexJobResponse): NoticeState {
  const targetLabel = SEARCH_TARGET_LABELS[job.entity_type] ?? '内容';
  if (job.status === 'budget_blocked') {
    return {
      tone: 'warning',
      title: '搜索更新等待模型额度恢复',
      message: '额度或策略变化后，系统会自动继续处理。',
    };
  }
  if (job.status === 'failed') {
    return {
      tone: 'danger',
      title: '搜索更新失败',
      message: job.error || `${targetLabel}没有完成搜索更新，可以稍后重试。`,
    };
  }
  return {
    tone: 'success',
    title: '搜索已更新',
    message: `${targetLabel}已经可以用于搜索和 AI 推荐。`,
  };
}

const SEARCH_TARGET_LABELS: Record<string, string> = {
  food: '食物',
  ingredient: '食材',
  recipe: '菜谱',
};

export function imageJobNotification(job: AiRenderResponse): BackgroundTaskNotification | null {
  if (!job.job_id) return null;
  const targetLabel = job.target_entity_type ? TARGET_LABELS[job.target_entity_type] ?? '图片' : '图片';
  const targetName = job.target_entity_name?.trim();
  let description = '生成图已保留，可以在对应页面继续使用';
  if (job.status === 'queued') {
    description = '已加入队列，稍后开始生成';
  } else if (job.status === 'running') {
    description = '正在生成图片，可以先处理其他内容';
  } else if (job.status === 'failed') {
    description = isModelUsageLimitCode(job.error_code)
      ? '图片生成额度已达到限制，本次未请求模型服务。'
      : job.error?.trim() || (job.can_retry
      ? '生成失败，可以直接重试'
        : '生成失败，当前不能安全地直接重试');
  } else if (job.bind_status === 'skipped') {
    description = '已有用户图片，生成图已保留';
  } else if (job.bind_status === 'bound') {
    description = '主图已自动更新';
  }
  return {
    notification_id: imageNotificationId(job.job_id),
    kind: 'background_task',
    task_kind: 'image',
    status: job.status,
    title: targetName ? `${targetName}的${targetLabel}图片生成` : `${targetLabel}图片生成`,
    description,
    can_retry: job.can_retry === true,
    can_dismiss: isTerminalImageJob(job),
    error_code: job.error_code ?? null,
    occurred_at: job.completed_at ?? job.created_at ?? null,
  };
}

export function searchJobNotification(job: SearchIndexJobResponse): BackgroundTaskNotification {
  const targetLabel = SEARCH_TARGET_LABELS[job.entity_type] ?? '内容';
  const targetName = job.target_name?.trim();
  let description = job.vector_status === 'indexed' ? '搜索和语义理解已更新' : '搜索已更新';
  const isBudgetBlocked = job.status === 'budget_blocked';
  const status: BackgroundTaskNotification['status'] = job.status === 'budget_blocked' ? 'failed' : job.status;
  if (job.status === 'queued') {
    description = '已加入队列，稍后更新搜索';
  } else if (job.status === 'running') {
    description = '正在更新搜索能力';
  } else if (isBudgetBlocked) {
    description = '额度或策略变化后，系统会自动继续处理。';
  } else if (job.status === 'failed') {
    description = job.error?.trim() || '搜索更新失败，可以直接重试';
  }
  return {
    notification_id: searchIndexNotificationId(job.job_id),
    kind: 'background_task',
    task_kind: 'search_index',
    status,
    title: isBudgetBlocked
      ? '搜索更新等待模型额度恢复'
      : targetName ? `${targetName}的${targetLabel}搜索更新` : `${targetLabel}搜索更新`,
    description,
    can_retry: !isBudgetBlocked && status === 'failed',
    can_dismiss: isTerminalSearchIndexJob(job),
    error_code: job.error_code ?? null,
    occurred_at: job.completed_at ?? job.created_at ?? null,
  };
}

export type BackgroundNotificationSource = {
  items: BackgroundTaskNotification[];
  isLoading: boolean;
  dismissJob: (notificationId: string) => void;
  retryJob: (notificationId: string) => void;
  retryingJobId: string | null;
};

export function useAiImageJobMonitor(enabled: boolean, options: { onNotice?: (notice: NoticeState) => void } = {}) {
  const { onNotice } = options;
  const queryClient = useQueryClient();
  const handledJobsRef = useRef<Set<string>>(new Set());
  const previousStatusesRef = useRef<Map<string, AiRenderResponse['status'] | SearchIndexJobResponse['status']>>(new Map());
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
        message: reason instanceof Error && reason.message ? reason.message : '任务没有重新提交成功，请稍后再试。',
      });
    },
  });

  useEffect(() => {
    if (!activeJobsQuery.data && !activeSearchIndexJobsQuery.data) {
      return;
    }
    const restoreIfRequeued = (notificationId: string, status: AiRenderResponse['status'] | SearchIndexJobResponse['status']) => {
      if (status !== 'queued' && status !== 'running') return;
      handledJobsRef.current.delete(notificationId);
      setDismissedJobIds((current) => {
        if (!current.has(notificationId)) return current;
        const next = new Set(current);
        next.delete(notificationId);
        writeJsonStorage(DISMISSED_AI_IMAGE_JOB_KEY, Array.from(next));
        return next;
      });
    };
    (activeJobsQuery.data ?? []).forEach((job) => {
      if (!job.job_id) return;
      const notificationId = imageNotificationId(job.job_id);
      restoreIfRequeued(notificationId, job.status);
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
      restoreIfRequeued(notificationId, job.status);
      if (handledJobsRef.current.has(notificationId)) {
        return;
      }
      if (isTerminalSearchIndexJob(job)) {
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
      ...(activeJobsQuery.data ?? []).map(imageJobNotification).filter((job): job is BackgroundTaskNotification => job !== null),
      ...(activeSearchIndexJobsQuery.data ?? []).map(searchJobNotification),
    ].find((item) => item.notification_id === notificationId);
    if (!visibleJob || !visibleJob.can_dismiss) {
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

  const items = useMemo(
    () => [
      ...(activeJobsQuery.data ?? []).map(imageJobNotification).filter((job): job is BackgroundTaskNotification => job !== null),
      ...(activeSearchIndexJobsQuery.data ?? []).map(searchJobNotification),
    ].filter((job) => !job.can_dismiss || !dismissedJobIds.has(job.notification_id)),
    [activeJobsQuery.data, activeSearchIndexJobsQuery.data, dismissedJobIds]
  );

  return {
    items,
    isLoading: activeJobsQuery.isLoading || activeSearchIndexJobsQuery.isLoading,
    dismissJob,
    retryJob,
    retryingJobId: retryJobMutation.isPending ? retryJobMutation.variables ?? null : null,
  };
}
