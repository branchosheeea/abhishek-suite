"use client"

import {
  allowedLocationTypes,
  isFieldVisible,
  recommendationsFor,
} from "@/lib/narrative/preamble/model"
import {
  ATTENDANCE_ACTIONS,
  INSPECTION_TYPES,
  LOADING_CONDITIONS,
  LOCATION_TYPES,
  VESSEL_STATUSES,
  findOption,
  type AttendanceActionId,
  type InspectionTypeId,
  type LoadingConditionId,
  type LocationTypeId,
  type VesselStatusId,
} from "@/lib/narrative/preamble/options"
import { FLEET_VESSELS } from "@/lib/vessels"
import { ConditionalField, FormSection, Recommendation, SelectField, TextField } from "./fields"
import type { PreambleFormProps } from "./form-types"

export function AttendanceDetailsForm({ inputs, facts, set, setDetail, messages, disabled }: PreambleFormProps) {
  const rec = recommendationsFor(inputs.inspectionType)
  const allowed = allowedLocationTypes(inputs.inspectionType)
  const typeLabel = findOption(INSPECTION_TYPES, inputs.inspectionType)?.label.toLowerCase()
  const show = (field: Parameters<typeof isFieldVisible>[0]) => isFieldVisible(field, inputs)
  const newbuilding = inputs.inspectionType === "NEWBUILDING" || inputs.attendanceAction === "BEFORE_DELIVERY_MAIDEN_VOYAGE"
  const sailing = inputs.inspectionType === "SAILING"

  const statusRecommendation =
    rec?.vesselStatus && !(inputs.vesselStatus && rec.vesselStatus.includes(inputs.vesselStatus)) ? rec.vesselStatus[0] : undefined

  return (
    <FormSection title="Attendance details" description="Where, when and why the Superintendent attended.">
      <div className="grid gap-4 @md:grid-cols-2">
        <TextField
          field="vessel"
          label="Vessel"
          required
          value={facts.vesselName}
          list="preamble-fleet-vessels"
          placeholder="Search the fleet or type a name"
          hint="Shared with Inspection Details."
          tooltip="Choose a fleet vessel from the list, or type the name of any other vessel. The name is used exactly as entered."
          onChange={(value) => setDetail("vessel", value)}
          messages={messages("vessel")}
          disabled={disabled}
          className="@md:col-span-2"
        />
        <datalist id="preamble-fleet-vessels">
          {FLEET_VESSELS.map((vessel) => (
            <option key={vessel} value={vessel} />
          ))}
        </datalist>

        <SelectField
          field="inspectionType"
          label="Inspection type"
          required
          value={inputs.inspectionType}
          placeholder="Select the inspection type…"
          options={INSPECTION_TYPES}
          onChange={(value) => set({ inspectionType: value as InspectionTypeId | "" })}
          messages={messages("inspectionType")}
          disabled={disabled}
          className="@md:col-span-2"
        />

        <SelectField
          field="attendanceAction"
          label="Attendance action"
          required
          value={inputs.attendanceAction}
          options={ATTENDANCE_ACTIONS}
          tooltip="How the attendance is described: “The Superintendent attended…”, “joined … and remained on board…”."
          onChange={(value) => set({ attendanceAction: value as AttendanceActionId })}
          messages={messages("attendanceAction")}
          disabled={disabled}
          className="@md:col-span-2"
        />

        <TextField
          field="startDate"
          label="Start date"
          required
          type="date"
          value={facts.startDate}
          hint="Shared with Inspection Details."
          onChange={(value) => setDetail("dateFrom", value)}
          messages={messages("startDate")}
          disabled={disabled}
        />
        <TextField
          field="endDate"
          label="End date"
          type="date"
          value={facts.endDate}
          hint="Leave empty for a one-day attendance."
          onChange={(value) => setDetail("dateTo", value)}
          messages={messages("endDate")}
          disabled={disabled}
        />

        <SelectField
          field="locationType"
          label="Attendance location type"
          required
          value={inputs.locationType}
          options={LOCATION_TYPES.map((option) => ({
            ...option,
            disabled: !allowed.includes(option.id),
            label: allowed.includes(option.id) ? option.label : `${option.label} (not used for this inspection type)`,
          }))}
          hint={allowed.length < LOCATION_TYPES.length && typeLabel ? `Options are limited for a ${typeLabel}.` : undefined}
          onChange={(value) => set({ locationType: value as LocationTypeId })}
          messages={messages("locationType")}
          disabled={disabled}
          className="@md:col-span-2"
          recommendation={
            rec?.locationType && rec.locationType !== inputs.locationType ? (
              <Recommendation
                text={`Recommended for ${rec.reason}: ${findOption(LOCATION_TYPES, rec.locationType)?.label}.`}
                onApply={() => set({ locationType: rec.locationType })}
                disabled={disabled}
              />
            ) : undefined
          }
        />

        {show("location") && (
          <TextField
            field="location"
            label="Location"
            required
            value={inputs.location}
            placeholder="e.g. Singapore"
            hint="Written as “at Singapore”. Add the country if useful: “Galle, Sri Lanka”."
            onChange={(value) => set({ location: value })}
            messages={messages("location")}
            disabled={disabled}
            className="@md:col-span-2"
          />
        )}
        {show("joiningLocation") && (
          <>
            <TextField
              field="joiningLocation"
              label={newbuilding ? "Joining location (maiden-voyage departure)" : "Joining location"}
              required
              value={inputs.joiningLocation}
              placeholder="e.g. Galle, Sri Lanka"
              onChange={(value) => set({ joiningLocation: value })}
              messages={messages("joiningLocation")}
              disabled={disabled}
            />
            <TextField
              field="disembarkationLocation"
              label={newbuilding ? "Disembarkation location (maiden-voyage arrival)" : "Disembarkation location"}
              required
              value={inputs.disembarkationLocation}
              placeholder="e.g. Singapore"
              onChange={(value) => set({ disembarkationLocation: value })}
              messages={messages("disembarkationLocation")}
              disabled={disabled}
            />
          </>
        )}
        {show("shipyardName") && (
          <>
            <TextField
              field="shipyardName"
              label="Shipyard name"
              required
              value={inputs.shipyardName}
              placeholder="e.g. Sembcorp Marine Admiralty Yard"
              onChange={(value) => set({ shipyardName: value })}
              messages={messages("shipyardName")}
              disabled={disabled}
              className="@md:col-span-2"
            />
            <TextField
              field="shipyardPort"
              label="Port"
              value={inputs.shipyardPort}
              onChange={(value) => set({ shipyardPort: value })}
              messages={messages("shipyardPort")}
              disabled={disabled}
            />
            <TextField
              field="shipyardCountry"
              label="Country"
              value={inputs.shipyardCountry}
              onChange={(value) => set({ shipyardCountry: value })}
              messages={messages("shipyardCountry")}
              disabled={disabled}
            />
          </>
        )}
        {show("voyageRoute") && (
          <TextField
            field="voyageRoute"
            label="Voyage route (if available)"
            value={inputs.voyageRoute}
            placeholder="e.g. Singapore to Fujairah"
            hint="Written as “on passage from Singapore to Fujairah”."
            onChange={(value) => set({ voyageRoute: value })}
            messages={messages("voyageRoute")}
            disabled={disabled}
            className="@md:col-span-2"
          />
        )}
        {show("otherLocation") && (
          <TextField
            field="otherLocation"
            label="Location"
            required
            value={inputs.otherLocation}
            placeholder="e.g. at Fujairah outer anchorage"
            hint="Inserted exactly as written, so include the preposition (“at …”, “off …”)."
            onChange={(value) => set({ otherLocation: value })}
            messages={messages("otherLocation")}
            disabled={disabled}
            className="@md:col-span-2"
          />
        )}

        <SelectField
          field="vesselStatus"
          label="Vessel status"
          required={sailing}
          value={inputs.vesselStatus}
          placeholder="Select the vessel status…"
          options={VESSEL_STATUSES}
          onChange={(value) => set({ vesselStatus: value as VesselStatusId | "" })}
          messages={messages("vesselStatus")}
          disabled={disabled}
          className="@md:col-span-2"
          recommendation={
            statusRecommendation && rec ? (
              <Recommendation
                text={`Recommended for ${rec.reason}: ${rec.vesselStatus!.map((id) => findOption(VESSEL_STATUSES, id)?.label).join(", ")}.`}
                onApply={() => set({ vesselStatus: statusRecommendation })}
                disabled={disabled}
              />
            ) : undefined
          }
        />
        {show("loadingCondition") && (
          <SelectField
            field="loadingCondition"
            label="Laden or ballast condition"
            hint="Stated once here and used throughout the report (Hull, Structural, Operational)."
            value={inputs.loadingCondition}
            placeholder="Not stated"
            options={LOADING_CONDITIONS}
            onChange={(value) => set({ loadingCondition: value as LoadingConditionId | "" })}
            messages={messages("loadingCondition")}
            disabled={disabled}
          />
        )}
      </div>

      <ConditionalField show={show("dockingCompletionDate")} label="Dry-docking details">
        <p className="text-xs font-medium text-muted-foreground">Dry-docking details</p>
        <div className="grid gap-4 @md:grid-cols-2">
          {show("specialSurveyNumber") && (
            <TextField
              field="specialSurveyNumber"
              label="Special Survey number"
              value={inputs.specialSurveyNumber}
              inputMode="numeric"
              placeholder="e.g. 3"
              hint="Written as “the vessel’s third Special Survey”."
              onChange={(value) => set({ specialSurveyNumber: value })}
              messages={messages("specialSurveyNumber")}
              disabled={disabled}
            />
          )}
          <TextField
            field="dockingCompletionDate"
            label="Dry-docking completion date"
            type="date"
            value={inputs.dockingCompletionDate}
            hint="A date after the attendance is described as planned, not completed."
            onChange={(value) => set({ dockingCompletionDate: value })}
            messages={messages("dockingCompletionDate")}
            disabled={disabled}
          />
        </div>
      </ConditionalField>

      <ConditionalField show={show("builder")} label="Newbuilding details">
        <p className="text-xs font-medium text-muted-foreground">Newbuilding details</p>
        <div className="grid gap-4 @md:grid-cols-2">
          <TextField
            field="builder"
            label="Builder"
            value={inputs.builder}
            placeholder="e.g. Hyundai Samho Heavy Industries"
            onChange={(value) => set({ builder: value })}
            messages={messages("builder")}
            disabled={disabled}
            className="@md:col-span-2"
          />
          <TextField
            field="deliveryDate"
            label="Delivery date"
            type="date"
            value={inputs.deliveryDate}
            onChange={(value) => set({ deliveryDate: value })}
            messages={messages("deliveryDate")}
            disabled={disabled}
          />
          <TextField
            field="guaranteeEndDate"
            label="Guarantee period end"
            type="date"
            value={inputs.guaranteeEndDate}
            onChange={(value) => set({ guaranteeEndDate: value })}
            messages={messages("guaranteeEndDate")}
            disabled={disabled}
          />
        </div>
      </ConditionalField>
    </FormSection>
  )
}
