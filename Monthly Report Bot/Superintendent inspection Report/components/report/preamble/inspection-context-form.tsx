"use client"

import {
  EXCLUSIVE_FOCUS,
  EXCLUSIVE_FOLLOW_UP,
  isFieldVisible,
  recommendationsFor,
  toggleExclusive,
  type PreambleField,
} from "@/lib/narrative/preamble/model"
import {
  CARGO_OPERATION_TYPES,
  CLOSING_STATEMENTS,
  DEFICIENCY_STATUSES,
  FOCUS_AREAS,
  FOLLOW_UP_METHODS,
  OPENING_MEETINGS,
  OPERATING_CONDITIONS,
  PRIMARY_OBJECTIVES,
  findOption,
  type CargoOperationId,
  type ClosingStatementId,
  type DeficiencyStatusId,
  type FocusAreaId,
  type FollowUpMethodId,
  type ObjectiveId,
  type OpeningMeetingId,
  type OperatingConditionId,
} from "@/lib/narrative/preamble/options"
import {
  ConditionalField,
  ConfirmField,
  FormSection,
  MultiSelectField,
  Recommendation,
  SelectField,
  TextAreaField,
  TextField,
} from "./fields"
import { inOptionOrder, type PreambleFormProps } from "./form-types"

function Inserted({ text }: { text: string }) {
  if (!text) return <>No sentence is inserted.</>
  return <>Inserts: “{text}”</>
}

export function InspectionContextForm({ inputs, set, messages, disabled }: PreambleFormProps) {
  const rec = recommendationsFor(inputs.inspectionType)
  const show = (field: PreambleField) => isFieldVisible(field, inputs)
  const conditionRecommendation =
    rec?.operatingCondition && !rec.operatingCondition.includes(inputs.operatingCondition) ? rec.operatingCondition[0] : undefined
  const focusSelected = (id: FocusAreaId) => inputs.additionalFocusAreas.includes(id)

  return (
    <>
      <FormSection title="Inspection context" description="Meeting, objectives and the conditions of the attendance.">
        <SelectField
          field="openingMeeting"
          label="Opening meeting"
          value={inputs.openingMeeting}
          options={OPENING_MEETINGS}
          hint={<Inserted text={findOption(OPENING_MEETINGS, inputs.openingMeeting)?.text ?? ""} />}
          onChange={(value) => set({ openingMeeting: value as OpeningMeetingId })}
          messages={messages("openingMeeting")}
          disabled={disabled}
        />

        <MultiSelectField
          field="primaryObjectives"
          label="Primary objectives"
          required
          options={PRIMARY_OBJECTIVES}
          values={inputs.primaryObjectives}
          recommended={rec?.objectives}
          tooltip="Completes “The inspection focused on …”. Choose all that apply; they are joined in a fixed order."
          onToggle={(id, checked) => {
            const next = checked ? [...inputs.primaryObjectives, id as ObjectiveId] : inputs.primaryObjectives.filter((v) => v !== id)
            set({ primaryObjectives: inOptionOrder(PRIMARY_OBJECTIVES, next) })
          }}
          messages={messages("primaryObjectives")}
          disabled={disabled}
        />
        <ConditionalField show={show("customObjective")} label="Other objective">
          <TextField
            field="customObjective"
            label="Other objective"
            required
            value={inputs.customObjective}
            placeholder="e.g. the condition of the exhaust gas cleaning system"
            hint="Completes the sentence “The inspection also addressed …”."
            onChange={(value) => set({ customObjective: value })}
            messages={messages("customObjective")}
            disabled={disabled}
          />
        </ConditionalField>

        <SelectField
          field="operatingCondition"
          label="Operating conditions"
          value={inputs.operatingCondition}
          options={OPERATING_CONDITIONS}
          hint="Completes “Machinery and systems were examined and tested, where practicable, under …”."
          onChange={(value) => set({ operatingCondition: value as OperatingConditionId })}
          messages={messages("operatingCondition")}
          disabled={disabled}
          recommendation={
            conditionRecommendation && rec ? (
              <Recommendation
                text={`Recommended for ${rec.reason}: ${rec.operatingCondition!.map((id) => findOption(OPERATING_CONDITIONS, id)?.label).join(" / ")}.`}
                onApply={() => set({ operatingCondition: conditionRecommendation })}
                disabled={disabled}
              />
            ) : undefined
          }
        />
      </FormSection>

      <FormSection title="Additional focus" description="Only the areas you tick are mentioned in the preamble.">
        <MultiSelectField
          field="additionalFocusAreas"
          label="Additional focus areas"
          options={FOCUS_AREAS}
          values={inputs.additionalFocusAreas}
          recommended={rec?.focus}
          columns={2}
          onToggle={(id, checked) =>
            set({
              additionalFocusAreas: inOptionOrder(
                FOCUS_AREAS,
                toggleExclusive(inputs.additionalFocusAreas, id as FocusAreaId, checked, EXCLUSIVE_FOCUS),
              ),
            })
          }
          messages={messages("additionalFocusAreas")}
          disabled={disabled}
        />

        <ConditionalField show={show("previousInspectionDate")} label="Previous inspection">
          <p className="text-xs font-medium text-muted-foreground">Previous-inspection follow-up</p>
          <div className="grid gap-4 @md:grid-cols-2">
            <TextField
              field="previousInspectionDate"
              label="Previous inspection date"
              type="date"
              value={inputs.previousInspectionDate}
              onChange={(value) => set({ previousInspectionDate: value })}
              messages={messages("previousInspectionDate")}
              disabled={disabled}
            />
            <TextField
              field="previousWorklistReference"
              label="Previous worklist reference"
              value={inputs.previousWorklistReference}
              placeholder="e.g. WL-2026-014"
              onChange={(value) => set({ previousWorklistReference: value })}
              messages={messages("previousWorklistReference")}
              disabled={disabled}
            />
          </div>
        </ConditionalField>

        <ConditionalField show={show("expectedSireDate")} label="SIRE 2.0 preparation">
          <TextField
            field="expectedSireDate"
            label="Expected SIRE 2.0 inspection date (if known)"
            type="date"
            value={inputs.expectedSireDate}
            onChange={(value) => set({ expectedSireDate: value })}
            messages={messages("expectedSireDate")}
            disabled={disabled}
          />
        </ConditionalField>

        <ConditionalField show={show("cargoOperationsWitnessed")} label="Cargo operations">
          <ConfirmField
            field="cargoOperationsWitnessed"
            label="Cargo operations were witnessed during the attendance"
            hint="Leave unticked if cargo matters were only reviewed; nothing is then said about witnessing."
            checked={inputs.cargoOperationsWitnessed}
            onChange={(checked) => set({ cargoOperationsWitnessed: checked })}
            messages={messages("cargoOperationsWitnessed")}
            disabled={disabled}
          />
          {show("cargoOperationType") && (
            <div className="grid gap-4 @md:grid-cols-2">
              <SelectField
                field="cargoOperationType"
                label="Operation type"
                value={inputs.cargoOperationType}
                placeholder="Not stated"
                options={CARGO_OPERATION_TYPES}
                onChange={(value) => set({ cargoOperationType: value as CargoOperationId | "" })}
                messages={messages("cargoOperationType")}
                disabled={disabled}
              />
              <TextField
                field="cargoType"
                label="Cargo type"
                value={inputs.cargoType}
                placeholder="e.g. crude oil"
                onChange={(value) => set({ cargoType: value })}
                messages={messages("cargoType")}
                disabled={disabled}
              />
            </div>
          )}
        </ConditionalField>

        <ConditionalField show={show("bunkeringWitnessed")} label="Bunkering operations">
          <ConfirmField
            field="bunkeringWitnessed"
            label="Bunkering operations were witnessed during the attendance"
            hint="Bunkering is mentioned only when this is ticked."
            checked={inputs.bunkeringWitnessed}
            onChange={(checked) => set({ bunkeringWitnessed: checked })}
            messages={messages("bunkeringWitnessed")}
            disabled={disabled}
          />
          {show("fuelGrade") && (
            <div className="grid gap-4 @md:grid-cols-2">
              <TextField
                field="fuelGrade"
                label="Fuel grade"
                value={inputs.fuelGrade}
                placeholder="e.g. VLSFO"
                onChange={(value) => set({ fuelGrade: value })}
                messages={messages("fuelGrade")}
                disabled={disabled}
              />
              <TextField
                field="bunkeringPort"
                label="Bunkering port"
                value={inputs.bunkeringPort}
                placeholder="e.g. Singapore"
                onChange={(value) => set({ bunkeringPort: value })}
                messages={messages("bunkeringPort")}
                disabled={disabled}
              />
            </div>
          )}
        </ConditionalField>
      </FormSection>

      <FormSection title="Findings and close" description="How the results and follow-up are described.">
        <SelectField
          field="deficiencyStatus"
          label="Deficiency status"
          value={inputs.deficiencyStatus}
          placeholder="Select the findings status…"
          options={DEFICIENCY_STATUSES}
          hint={
            inputs.deficiencyStatus ? (
              <Inserted text={findOption(DEFICIENCY_STATUSES, inputs.deficiencyStatus)?.text ?? ""} />
            ) : (
              "Never assumed: until you choose, a neutral sentence is used."
            )
          }
          onChange={(value) => set({ deficiencyStatus: value as DeficiencyStatusId | "" })}
          messages={messages("deficiencyStatus")}
          disabled={disabled}
        />

        <MultiSelectField
          field="followUpMethods"
          label="Follow-up method"
          options={FOLLOW_UP_METHODS}
          values={inputs.followUpMethods}
          columns={2}
          tooltip="Completes “Items requiring further action have been included in … for tracking through to closure.”"
          onToggle={(id, checked) =>
            set({
              followUpMethods: inOptionOrder(
                FOLLOW_UP_METHODS,
                toggleExclusive(inputs.followUpMethods, id as FollowUpMethodId, checked, EXCLUSIVE_FOLLOW_UP),
              ),
            })
          }
          messages={messages("followUpMethods")}
          disabled={disabled}
        />
        <ConditionalField show={show("customFollowUpMethod")} label="Other follow-up record">
          <TextField
            field="customFollowUpMethod"
            label="Other follow-up record"
            required
            value={inputs.customFollowUpMethod}
            placeholder="e.g. fleet technical action log"
            onChange={(value) => set({ customFollowUpMethod: value })}
            messages={messages("customFollowUpMethod")}
            disabled={disabled}
          />
        </ConditionalField>

        <SelectField
          field="closingStatement"
          label="Closing acknowledgment"
          value={inputs.closingStatement}
          options={CLOSING_STATEMENTS}
          hint={<Inserted text={findOption(CLOSING_STATEMENTS, inputs.closingStatement)?.text ?? ""} />}
          onChange={(value) => set({ closingStatement: value as ClosingStatementId })}
          messages={messages("closingStatement")}
          disabled={disabled}
        />

        <TextAreaField
          field="additionalNote"
          label="Additional factual note (optional)"
          value={inputs.additionalNote}
          placeholder="Only for an exceptional fact the selections above cannot express."
          hint="Inserted as written, before the discussion sentence. The standard wording itself cannot be edited."
          onChange={(value) => set({ additionalNote: value })}
          messages={messages("additionalNote")}
          disabled={disabled}
        />
      </FormSection>
    </>
  )
}
