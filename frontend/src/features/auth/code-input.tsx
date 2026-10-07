"use client";

import { cn } from "cn";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

/**
 * The 6 digits of an authenticator app as six large boxes (DOKUMEN-UI-UX L49). One real input underneath,
 * so pasting a code and the phone's one-time-code autofill work, and it carries the label and errors.
 */
export function CodeInput({
  id,
  value,
  onChange,
  onComplete,
  invalid,
  describedBy,
  autoFocus,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  invalid?: boolean;
  describedBy?: string | undefined;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <InputOTP
      id={id}
      maxLength={6}
      pattern={REGEXP_ONLY_DIGITS}
      inputMode="numeric"
      autoComplete="one-time-code"
      value={value}
      onChange={onChange}
      {...(onComplete ? { onComplete } : {})}
      autoFocus={autoFocus}
      disabled={disabled}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
    >
      <InputOTPGroup>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <InputOTPSlot
            key={i}
            index={i}
            className={cn("size-12 text-xl font-semibold text-text-900 md:size-11", invalid && "border-danger")}
          />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}
