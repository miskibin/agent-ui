"use client"

import * as React from "react"

import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export type SettingsSectionProps = {
  id: string
  title: string
  description?: string
  children: React.ReactNode
}

export function SettingsSection({
  id,
  title,
  description,
  children,
}: SettingsSectionProps) {
  return (
    <section id={id} data-slot="settings-section" className="scroll-mt-8">
      <div className="mb-2.5 px-0.5">
        <h2 className="text-[13.5px] font-medium text-foreground">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <Card
        data-slot="settings-panel"
        className="gap-0 divide-y overflow-hidden py-0 shadow-xs"
      >
        {children}
      </Card>
    </section>
  )
}

export type SettingsRowProps = {
  /** Rendered as a <label> when `htmlFor` is set, so the row title is clickable. */
  title: React.ReactNode
  htmlFor?: string
  description?: React.ReactNode
  /** Right-hand control on the title line. */
  control?: React.ReactNode
  /** Full-width content below the title line (inputs, hints, previews). */
  children?: React.ReactNode
  className?: string
}

export function SettingsRow({
  title,
  htmlFor,
  description,
  control,
  children,
  className,
}: SettingsRowProps) {
  const Title = htmlFor ? "label" : "div"

  return (
    <div
      data-slot="settings-row"
      className={cn("flex flex-col gap-2.5 px-4 py-3.5", className)}
    >
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <Title
            {...(htmlFor ? { htmlFor } : {})}
            className={cn(
              "block text-[13px] font-medium text-foreground",
              htmlFor && "cursor-pointer"
            )}
          >
            {title}
          </Title>
          {description ? (
            <p className="mt-0.5 text-[12px] leading-snug break-words text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {control ? (
          <div className="flex shrink-0 items-center gap-2">{control}</div>
        ) : null}
      </div>
      {children}
    </div>
  )
}
