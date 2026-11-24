import type { PreambleFacts, PreambleInputs } from "@/lib/narrative/preamble/model"
import type { IssueField } from "@/lib/narrative/preamble/validate"
import type { FieldMessages } from "./fields"

/** Inspection Details fields the Preamble reads and writes (single source for vessel and dates). */
export type DetailsField = "vessel" | "dateFrom" | "dateTo"

export type PreambleFormProps = {
  inputs: PreambleInputs
  facts: PreambleFacts
  set: (patch: Partial<PreambleInputs>) => void
  setDetail: (field: DetailsField, value: string) => void
  messages: (field: IssueField) => FieldMessages
  disabled: boolean
  /** New reports: the vessel is chosen from the Vessel Master in Inspection Details, not typed here. */
  vesselChosenInDetails?: boolean
}

/** Keeps multi-select values in the fixed option order, so saved data and generated text are stable. */
export function inOptionOrder<T extends string>(options: readonly { id: string }[], values: readonly T[]): T[] {
  return options.map((option) => option.id).filter((id): id is T => values.includes(id as T))
}
