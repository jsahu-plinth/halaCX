"use client";

import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";
import { Loading01 } from "@untitledui/icons";
import type { ReactNode } from "react";

type ButtonProps = Omit<AriaButtonProps,"className"|"children"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg" | "icon";
  loading?: boolean;
  className?: string;
  children?: ReactNode;
  title?: string;
};

export function Button({ variant="primary", size="md", loading=false, className="", children, isDisabled, ...props }:ButtonProps){
  return <AriaButton {...props} isDisabled={isDisabled||loading} className={`ui-button ui-button-${variant} ui-button-${size} ${className}`} data-loading={loading||undefined}>{loading?<Loading01 className="ui-spinner"/>:null}{children}</AriaButton>;
}
