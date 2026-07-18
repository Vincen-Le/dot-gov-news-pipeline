import {
  CapabilitiesDataSchema,
  type OperatorCapabilityName,
} from "@dot-gov-news/contracts";
import { useQuery } from "@tanstack/react-query";

import { fetchOperator } from "../api";
import { ErrorState, LoadingState, NotEnabled } from "../components";

export function CapabilityPage({
  capability,
  title,
}: {
  capability: OperatorCapabilityName;
  title: string;
}) {
  const query = useQuery({
    queryFn: () =>
      fetchOperator("/ops/v1/capabilities", CapabilitiesDataSchema),
    queryKey: ["capabilities"],
  });
  if (query.isLoading) return <LoadingState />;
  if (query.error !== null) return <ErrorState error={query.error} />;
  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">I</span>
        <div>
          <p className="eyebrow">Pipeline stage</p>
          <h1>{title}</h1>
        </div>
      </section>
      <NotEnabled
        capability={query.data?.data.capabilities[capability]}
        title={`${title} observability is capability-gated`}
      />
    </div>
  );
}
