import { lazy, Suspense, type ComponentProps } from 'react';

const HomeDashboardDialogs = lazy(() =>
  import('../features/home/HomeDashboardDialogs').then((module) => ({ default: module.HomeDashboardDialogs })),
);

export type AppHomeDashboardDialogsProps = ComponentProps<typeof HomeDashboardDialogs>;

/** Application composition entry for the home dashboard overlay bundle. */
export function AppHomeDashboardDialogs(props: AppHomeDashboardDialogsProps) {
  return (
    <Suspense fallback={null}>
      <HomeDashboardDialogs {...props} />
    </Suspense>
  );
}
