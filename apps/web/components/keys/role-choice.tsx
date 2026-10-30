"use client";

import type { ApiKey } from "@memdot/sdk";
import { Field, FieldDescription, FieldLabel, FieldTitle } from "@memdot/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@memdot/ui/components/radio-group";

type Role = ApiKey["role"];

export const ROLES: { value: Role; title: string; description: string }[] = [
  {
    value: "read_write",
    title: "Read and write",
    description: "Store, read, share and delete files.",
  },
  { value: "read_only", title: "Read only", description: "List, read and verify. No writes." },
  { value: "management", title: "Management", description: "Everything, plus keys and agents." },
];

// From sean0205/c-radio-group-8 (21st.dev): full-width option rows inside one bordered card.
export function RoleChoice({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as Role)}
      className="gap-0 overflow-hidden rounded-xl border border-border bg-surface-1"
    >
      {ROLES.map((role) => (
        <Field key={role.value} className="border-b border-border last:border-0">
          <FieldLabel
            htmlFor={`role-${role.value}`}
            className="cursor-pointer items-start gap-3 px-4 py-3 hover:bg-surface-2 has-data-[state=checked]:bg-surface-2"
          >
            <RadioGroupItem value={role.value} id={`role-${role.value}`} className="mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <FieldTitle>{role.title}</FieldTitle>
              <FieldDescription className="text-ui-sm">{role.description}</FieldDescription>
            </div>
          </FieldLabel>
        </Field>
      ))}
    </RadioGroup>
  );
}
