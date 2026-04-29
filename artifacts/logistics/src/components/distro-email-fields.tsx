import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import * as z from "zod";
import {
  validateDistroEmails,
  type DistroEmailValidation,
} from "@workspace/distro-email";
import type { Control, FieldValues, Path } from "react-hook-form";

export function DistroEmailFeedback({
  summary,
  tokenTestIdPrefix,
  previewTestId,
  summaryTestId,
  warningTestId,
}: {
  summary: DistroEmailValidation;
  tokenTestIdPrefix: string;
  previewTestId: string;
  summaryTestId: string;
  warningTestId: string;
}) {
  if (summary.tokens.length === 0) return null;
  const { tokens, validCount, invalidCount } = summary;
  const validLabel = `${validCount} valid recipient${validCount === 1 ? "" : "s"}`;
  const invalidLabel = `${invalidCount} invalid`;
  return (
    <>
      <div className="flex flex-wrap gap-1 pt-1" data-testid={previewTestId}>
        {tokens.map((t) => (
          <span
            key={t.value}
            className={
              "font-mono text-[10px] px-1.5 py-0.5 rounded-sm border " +
              (t.valid
                ? "bg-muted/30 border-border text-foreground/80"
                : "bg-destructive/10 border-destructive/40 text-destructive")
            }
            title={t.valid ? t.value : `Not a valid email: ${t.value}`}
            data-testid={
              t.valid
                ? `${tokenTestIdPrefix}-valid-${t.value}`
                : `${tokenTestIdPrefix}-invalid-${t.value}`
            }
          >
            {t.value}
            {!t.valid && (
              <span className="ml-1 uppercase tracking-widest text-[8px]">invalid</span>
            )}
          </span>
        ))}
      </div>
      <p
        className={
          "font-mono text-[10px] tracking-wide " +
          (invalidCount > 0 ? "text-destructive" : "text-muted-foreground")
        }
        data-testid={summaryTestId}
      >
        {invalidCount > 0 ? `${validLabel}, ${invalidLabel}.` : `${validLabel}.`}
      </p>
      {invalidCount > 0 && (
        <p
          className="font-mono text-[10px] text-destructive tracking-wide"
          data-testid={warningTestId}
        >
          {invalidCount === 1
            ? "1 entry doesn't look like an email address (expected name@domain). Fix or remove it before saving."
            : `${invalidCount} entries don't look like email addresses (expected name@domain). Fix or remove them before saving.`}
        </p>
      )}
    </>
  );
}

/**
 * Shared zod schema piece for the To/CC/BCC distro textareas. Blocks save when
 * any non-empty entry fails the same email-shape regex used by the API and
 * mailto: pipeline.
 */
export const distroEmailsField = z
  .string()
  .optional()
  .superRefine((val, ctx) => {
    const summary = validateDistroEmails(val);
    if (summary.invalidCount === 0) return;
    const list = summary.invalidEmails.join(", ");
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        summary.invalidCount === 1
          ? `Invalid email address: ${list}. Fix or remove it before saving.`
          : `Invalid email addresses: ${list}. Fix or remove them before saving.`,
    });
  });

interface DistroFieldConfig {
  name: string;
  label: string;
  rows: number;
  placeholder: string;
  helper: string;
  testIdPrefix: string;
  textareaTestId: string;
  previewTestId: string;
  summaryTestId: string;
  warningTestId: string;
}

const DISTRO_FIELD_CONFIGS: Record<"to" | "cc" | "bcc", DistroFieldConfig> = {
  to: {
    name: "distroEmails",
    label: "Recipient Emails (To)",
    rows: 4,
    placeholder: "s4@unit.example.mil\nbn-log@unit.example.mil",
    helper:
      "Pre-filled into the To: field when this unit's schedules are emailed. One address per line — commas, semicolons, and whitespace also work. Leave blank for an empty draft.",
    testIdPrefix: "distro-email",
    textareaTestId: "textarea-distro-emails",
    previewTestId: "distro-emails-preview",
    summaryTestId: "distro-emails-summary",
    warningTestId: "distro-emails-warning",
  },
  cc: {
    name: "distroCcEmails",
    label: "CC Emails (Optional)",
    rows: 3,
    placeholder: "bn-s4@unit.example.mil\nco-cdr@unit.example.mil",
    helper:
      "Pre-filled into the CC: field — visibility recipients (supporting battalion, company commander, higher HQ) who should see the schedule but are not action addressees. Leave blank to omit CC from the draft.",
    testIdPrefix: "distro-cc-email",
    textareaTestId: "textarea-distro-cc-emails",
    previewTestId: "distro-cc-emails-preview",
    summaryTestId: "distro-cc-emails-summary",
    warningTestId: "distro-cc-emails-warning",
  },
  bcc: {
    name: "distroBccEmails",
    label: "BCC Emails (Optional)",
    rows: 3,
    placeholder: "watch-officer@unit.example.mil\narchive@unit.example.mil",
    helper:
      "Pre-filled into the BCC: field — silent recipients (operations watch officer, archive mailbox, COC liaison) hidden from To and CC. Leave blank to omit BCC from the draft.",
    testIdPrefix: "distro-bcc-email",
    textareaTestId: "textarea-distro-bcc-emails",
    previewTestId: "distro-bcc-emails-preview",
    summaryTestId: "distro-bcc-emails-summary",
    warningTestId: "distro-bcc-emails-warning",
  },
};

function DistroFieldRow<TForm extends FieldValues>({
  control,
  config,
}: {
  control: Control<TForm>;
  config: DistroFieldConfig;
}) {
  return (
    <FormField
      control={control}
      name={config.name as Path<TForm>}
      render={({ field }) => {
        const summary = validateDistroEmails(field.value as string | undefined);
        return (
          <FormItem>
            <FormLabel className="font-mono uppercase text-xs">{config.label}</FormLabel>
            <FormControl>
              <Textarea
                {...field}
                value={(field.value as string | undefined) ?? ""}
                rows={config.rows}
                placeholder={config.placeholder}
                className="font-mono text-xs"
                data-testid={config.textareaTestId}
              />
            </FormControl>
            <p className="font-mono text-[10px] text-muted-foreground tracking-wide">
              {config.helper}
            </p>
            <DistroEmailFeedback
              summary={summary}
              tokenTestIdPrefix={config.testIdPrefix}
              previewTestId={config.previewTestId}
              summaryTestId={config.summaryTestId}
              warningTestId={config.warningTestId}
            />
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

/**
 * Renders the Schedule Distribution List card with To / CC / BCC textareas
 * wired to the `distroEmails`, `distroCcEmails`, and `distroBccEmails` form
 * fields (which must use the shared `distroEmailsField` zod schema).
 */
export function DistroEmailFieldsCard<TForm extends FieldValues>({
  control,
}: {
  control: Control<TForm>;
}) {
  return (
    <Card data-testid="card-distro-section">
      <CardHeader className="pb-3 pt-4 px-4 border-b border-border">
        <CardTitle className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">
          Schedule Distribution List
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <DistroFieldRow control={control} config={DISTRO_FIELD_CONFIGS.to} />
        <DistroFieldRow control={control} config={DISTRO_FIELD_CONFIGS.cc} />
        <DistroFieldRow control={control} config={DISTRO_FIELD_CONFIGS.bcc} />
      </CardContent>
    </Card>
  );
}
