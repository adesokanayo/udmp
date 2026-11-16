/** SaaS Exit Score (spec/EXIT-SCORE.md). */

export const CRITERIA = ["api_access", "schema_introspection", "relational_integrity", "export_throughput", "attachment_portability"] as const;
export type Criterion = (typeof CRITERIA)[number];

export interface CriterionScore { points: number; evidence: string[]; notes?: string }

export interface Scorecard {
  platform: string;
  display_name: string;
  plan?: string;
  scored_at: string;
  scored_by: string;
  criteria: Record<Criterion, CriterionScore>;
  modifiers?: {
    data_act_procedure?: boolean;
    udmp_native_export?: boolean;
    udmp_native_import?: boolean;
    cancellation_grace_days?: number | null;
  };
}

export interface ScoreResult { total: number; grade: "A" | "B" | "C" | "D" | "F"; label: string; errors: string[] }

const ALLOWED = new Set([0, 5, 10, 15, 20]);

export function gradeFor(total: number): ScoreResult["grade"] {
  return total >= 90 ? "A" : total >= 75 ? "B" : total >= 60 ? "C" : total >= 40 ? "D" : "F";
}

const LABELS: Record<ScoreResult["grade"], string> = {
  A: "Open. Leaving is a weekend project.",
  B: "Fair.",
  C: "Sticky.",
  D: "Captive.",
  F: "Hostage.",
};

export function computeScore(card: Scorecard): ScoreResult {
  const errors: string[] = [];
  let total = 0;
  for (const c of CRITERIA) {
    const s = card.criteria?.[c];
    if (!s) { errors.push(`missing criterion ${c}`); continue; }
    if (!ALLOWED.has(s.points)) errors.push(`${c}: points must be one of 0,5,10,15,20 (got ${s.points})`);
    if (!Array.isArray(s.evidence) || s.evidence.length === 0) errors.push(`${c}: at least one evidence URL is required`);
    else for (const u of s.evidence) { try { new URL(u); } catch { errors.push(`${c}: evidence "${u}" is not a URL`); } }
    total += Number(s.points) || 0;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(card.scored_at ?? "")) errors.push("scored_at must be YYYY-MM-DD");
  if (!card.scored_by) errors.push("scored_by is required");
  const grade = gradeFor(total);
  return { total, grade, label: LABELS[grade], errors };
}
