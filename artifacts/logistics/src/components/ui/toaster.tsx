import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastCountdown,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, duration, ...props }) {
        const showCountdown =
          typeof duration === "number" && Number.isFinite(duration) && duration > 0
        return (
          <Toast key={id} duration={duration} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
            {showCountdown && <ToastCountdown duration={duration!} />}
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
