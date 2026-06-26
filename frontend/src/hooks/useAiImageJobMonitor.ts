import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { invalidateAfterAiImageJobChanged } from '../api/cacheInvalidation';
import { queryKeys } from '../api/queryKeys';
import type { AiRenderResponse } from '../api/types';
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

function isTerminalJob(job: AiRenderResponse) {
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

export function useAiImageJobMonitor(enabled: boolean, options: { onNotice?: (notice: NoticeState) => void } = {}) {
  const { onNotice } = options;
  const queryClient = useQueryClient();
  const handledJobsRef = useRef<Set<string>>(new Set());
  const previousStatusesRef = useRef<Map<string, AiRenderResponse['status']>>(new Map());
  const initializedRef = useRef(false);
  const [dismissedJobIds, setDismissedJobIds] = useState<Set<string>>(() => new Set(readJsonStorage<string[]>(DISMISSED_AI_IMAGE_JOB_KEY, [])));
  const activeJobsQuery = useQuery({
    queryKey: queryKeys.aiImageJobs,
    queryFn: api.getActiveAiRenderJobs,
    enabled,
    refetchInterval: enabled ? 3000 : false,
  });
  const retryJobMutation = useMutation({
    mutationFn: (jobId: string) => api.retryAiRenderJob(jobId),
    onSuccess: (retriedJob) => {
      if (retriedJob.job_id) {
        handledJobsRef.current.delete(retriedJob.job_id);
        previousStatusesRef.current.set(retriedJob.job_id, retriedJob.status);
        setDismissedJobIds((current) => {
          if (!retriedJob.job_id || !current.has(retriedJob.job_id)) {
            return current;
          }
          const next = new Set(current);
          next.delete(retriedJob.job_id);
          writeJsonStorage(DISMISSED_AI_IMAGE_JOB_KEY, Array.from(next));
          return next;
        });
      }
      queryClient.setQueryData<AiRenderResponse[]>(queryKeys.aiImageJobs, (current) => {
        const jobs = current ?? [];
        if (!retriedJob.job_id) {
          return jobs;
        }
        if (jobs.some((job) => job.job_id === retriedJob.job_id)) {
          return jobs.map((job) => (job.job_id === retriedJob.job_id ? retriedJob : job));
        }
        return [retriedJob, ...jobs];
      });
      void activeJobsQuery.refetch();
    },
    onError: (reason) => {
      onNotice?.({
        tone: 'danger',
        title: '重试失败',
        message: reason instanceof Error && reason.message ? reason.message : '图片生成任务没有重新提交成功，请稍后再试。',
      });
    },
  });

  useEffect(() => {
    if (!activeJobsQuery.data) {
      return;
    }
    activeJobsQuery.data.forEach((job) => {
      if (!job.job_id || handledJobsRef.current.has(job.job_id)) {
        return;
      }
      if (job.status === 'succeeded' || job.status === 'failed') {
        handledJobsRef.current.add(job.job_id);
        invalidateAfterAiImageJobChanged(queryClient, job);
        const previousStatus = previousStatusesRef.current.get(job.job_id);
        if ((initializedRef.current && !previousStatus) || (previousStatus && previousStatus !== job.status)) {
          onNotice?.(buildImageJobNotice(job));
        }
      }
      previousStatusesRef.current.set(job.job_id, job.status);
    });
    initializedRef.current = true;
  }, [activeJobsQuery.data, onNotice, queryClient]);

  const dismissJob = useCallback((jobId: string) => {
    const job = activeJobsQuery.data?.find((item) => item.job_id === jobId);
    if (!job || !isTerminalJob(job)) {
      return;
    }
    setDismissedJobIds((current) => {
      if (current.has(jobId)) {
        return current;
      }
      const next = new Set(current);
      next.add(jobId);
      writeJsonStorage(DISMISSED_AI_IMAGE_JOB_KEY, Array.from(next));
      return next;
    });
  }, [activeJobsQuery.data]);

  const retryJob = useCallback((jobId: string) => {
    void retryJobMutation.mutateAsync(jobId).catch(() => undefined);
  }, [retryJobMutation]);

  const visibleJobs = useMemo(
    () => (activeJobsQuery.data ?? []).filter((job) => !job.job_id || !isTerminalJob(job) || !dismissedJobIds.has(job.job_id)),
    [activeJobsQuery.data, dismissedJobIds]
  );

  return {
    jobs: visibleJobs,
    isLoading: activeJobsQuery.isLoading,
    dismissJob,
    retryJob,
    retryingJobId: retryJobMutation.isPending ? retryJobMutation.variables ?? null : null,
  };
}
