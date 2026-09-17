"use client";

import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

export type AppleSelectOption<Value extends string = string> = {
  value: Value;
  label: string;
  description?: string;
  disabled?: boolean;
};

type AppleSelectProps<Value extends string> = {
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  disabled?: boolean;
  onChange: (value: Value) => void;
  options: readonly AppleSelectOption<Value>[];
  placeholder?: string;
  required?: boolean;
  value: Value;
};

type PopoverPosition = {
  bottom?: number;
  left: number;
  maxHeight: number;
  placement: "top" | "bottom";
  top?: number;
  width: number;
};

function ChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="m4 6 4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="m3.5 8.2 2.8 2.8 6.2-6.3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export function AppleSelect<Value extends string>({
  ariaLabel,
  autoFocus = false,
  className = "",
  disabled = false,
  onChange,
  options,
  placeholder = "请选择",
  required = false,
  value,
}: AppleSelectProps<Value>) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const enabledIndices = useMemo(
    () => options.flatMap((option, index) => (option.disabled ? [] : [index])),
    [options],
  );

  function initialIndex(direction: "first" | "last" = "first") {
    if (selectedIndex >= 0 && !options[selectedIndex]?.disabled) return selectedIndex;
    return direction === "last" ? (enabledIndices.at(-1) ?? 0) : (enabledIndices.at(0) ?? 0);
  }

  function openList(direction: "first" | "last" = "first") {
    if (disabled || !enabledIndices.length) return;
    setActiveIndex(initialIndex(direction));
    setOpen(true);
  }

  function closeList({ restoreFocus = false } = {}) {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function selectIndex(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeList({ restoreFocus: true });
  }

  function moveActive(direction: 1 | -1) {
    if (!enabledIndices.length) return;
    const currentPosition = enabledIndices.indexOf(activeIndex);
    const nextPosition =
      currentPosition < 0
        ? direction > 0
          ? 0
          : enabledIndices.length - 1
        : (currentPosition + direction + enabledIndices.length) % enabledIndices.length;
    setActiveIndex(enabledIndices[nextPosition] ?? 0);
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) openList(event.key === "ArrowUp" ? "last" : "first");
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && !open) {
      event.preventDefault();
      openList();
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closeList({ restoreFocus: true });
    }
  }

  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(
        event.key === "Home" ? (enabledIndices.at(0) ?? index) : (enabledIndices.at(-1) ?? index),
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectIndex(index);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeList({ restoreFocus: true });
      return;
    }
    if (event.key === "Tab") closeList();
  }

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !listboxRef.current?.contains(target)) closeList();
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") closeList({ restoreFocus: true });
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) closeList();
  }, [disabled, open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => optionRefs.current[activeIndex]?.focus());
  }, [activeIndex, open]);

  useLayoutEffect(() => {
    if (!open) return;

    function updatePosition() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 8;
      const gap = 6;
      const availableBelow = window.innerHeight - rect.bottom - margin - gap;
      const availableAbove = rect.top - margin - gap;
      const estimatedHeight = Math.min(320, options.length * 48 + 12);
      const placement =
        availableBelow >= Math.min(estimatedHeight, 180) || availableBelow >= availableAbove
          ? "bottom"
          : "top";
      const available = placement === "bottom" ? availableBelow : availableAbove;
      const maxHeight = Math.max(96, Math.min(320, available));
      const width = Math.min(rect.width, window.innerWidth - margin * 2);
      const left = Math.min(
        Math.max(margin, rect.left),
        Math.max(margin, window.innerWidth - width - margin),
      );

      setPosition({
        bottom: placement === "top" ? window.innerHeight - rect.top + gap : undefined,
        left,
        maxHeight,
        placement,
        top: placement === "bottom" ? rect.bottom + gap : undefined,
        width,
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, options.length]);

  const popoverStyle: CSSProperties | undefined = position
    ? {
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        top: position.top,
        width: position.width,
      }
    : undefined;
  const hasPlaceholder = !selectedOption;

  return (
    <div
      className={`apple-select${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        className="apple-select__trigger"
        type="button"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${ariaLabel}：${selectedOption?.label || placeholder}`}
        autoFocus={autoFocus}
        data-placeholder={hasPlaceholder || undefined}
        data-required={required || undefined}
        disabled={disabled}
        onClick={() => (open ? closeList({ restoreFocus: true }) : openList())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="apple-select__value">{selectedOption?.label || placeholder}</span>
        <span className="apple-select__chevron">
          <ChevronIcon />
        </span>
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={listboxRef}
              className="apple-select__popover"
              data-placement={position?.placement || "bottom"}
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel}
              style={popoverStyle}
            >
              {options.map((option, index) => (
                <button
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  className="apple-select__option"
                  type="button"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  key={option.value}
                  role="option"
                  tabIndex={index === activeIndex ? 0 : -1}
                  onClick={() => selectIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onKeyDown={(event) => handleOptionKeyDown(event, index)}
                  onPointerMove={() => {
                    if (!option.disabled) setActiveIndex(index);
                  }}
                >
                  <span>
                    <strong>{option.label}</strong>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                  {option.value === value ? (
                    <span className="apple-select__check">
                      <CheckIcon />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
