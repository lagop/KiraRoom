"use client";

import { useTranslations } from "@/lib/use-translation";

interface Appointment {
  id: string;
  scheduledDate: string;
  scheduledTime: string;
  status: string;
  paymentStatus: string;
  totalAmount: number;
  amountPaid: number;
  amountDue: number;
  depositRequired: boolean;
  depositAmount: number | null;
  depositPaid: boolean;
  client: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  professional: {
    id: string;
    firstName: string;
    lastName: string;
  };
  service: {
    id: string;
    name: string;
    price: number;
    duration: number;
  };
  payments: Array<{
    id: string;
    amount: number;
    status: string;
    type: string;
    isDeposit: boolean;
    createdAt: string;
  }>;
}

interface AppointmentCartSummaryProps {
  appointment: Appointment;
  paymentType: "full" | "deposit" | "balance";
  onPaymentTypeChange: (type: "full" | "deposit" | "balance") => void;
}

export default function AppointmentCartSummary({
  appointment,
  paymentType,
  onPaymentTypeChange,
}: AppointmentCartSummaryProps) {
  const t = useTranslations();

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-EU", {
      style: "currency",
      currency: "EUR",
    }).format(amount / 100);
  };

  const getAmountDue = () => {
    if (paymentType === "full") {
      return appointment.totalAmount;
    }
    if (paymentType === "deposit" && appointment.depositRequired && !appointment.depositPaid) {
      return appointment.depositAmount || 0;
    }
    if (paymentType === "balance" && appointment.depositPaid) {
      return appointment.totalAmount - (appointment.depositAmount || 0);
    }
    return appointment.totalAmount;
  };

  const getPaymentDescription = () => {
    if (paymentType === "full") {
      return t("pos.full_payment_description");
    }
    if (paymentType === "deposit") {
      return t("pos.deposit_payment_description");
    }
    return t("pos.balance_payment_description");
  };

  return (
    <div className="bg-gray-50 rounded-lg p-4 space-y-3">
      <div className="border-b pb-2">
        <h3 className="font-semibold text-lg">{t("pos.appointment_details")}</h3>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-sm text-gray-500">{t("pos.client")}</div>
          <div className="font-medium">
            {appointment.client.firstName} {appointment.client.lastName}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500">{t("pos.service")}</div>
          <div className="font-medium">{appointment.service.name}</div>
        </div>
        <div>
          <div className="text-sm text-gray-500">{t("pos.date")}</div>
          <div className="font-medium">
            {new Date(appointment.scheduledDate).toLocaleDateString("es-ES", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500">{t("pos.time")}</div>
          <div className="font-medium">{appointment.scheduledTime}</div>
        </div>
        <div>
          <div className="text-sm text-gray-500">{t("pos.professional")}</div>
          <div className="font-medium">
            {appointment.professional.firstName} {appointment.professional.lastName}
          </div>
        </div>
      </div>

      <div className="border-t pt-3">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-gray-600">{t("pos.total_amount")}:</span>
          <span className="font-semibold">{formatCurrency(appointment.totalAmount)}</span>
        </div>

        {appointment.depositPaid && appointment.depositAmount && (
          <div className="flex justify-between items-center mb-2 text-green-600">
            <span className="text-sm">{t("pos.deposit_paid")}:</span>
            <span>- {formatCurrency(appointment.depositAmount)}</span>
          </div>
        )}

        <div className="flex justify-between items-center text-lg font-bold border-t pt-2">
          <span>{t("pos.amount_due")}:</span>
          <span className="text-blue-600">{formatCurrency(getAmountDue())}</span>
        </div>
      </div>

      {appointment.depositRequired && (
        <div className="border-t pt-3">
          <div className="text-sm font-medium text-gray-700 mb-2">{t("pos.payment_type")}</div>
          <div className="flex gap-2">
            {appointment.depositRequired && !appointment.depositPaid ? (
              <>
                <button
                  onClick={() => onPaymentTypeChange("deposit")}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border ${
                    paymentType === "deposit"
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  {t("pos.pay_deposit")} - {formatCurrency(appointment.depositAmount || 0)}
                </button>
                <button
                  onClick={() => onPaymentTypeChange("full")}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border ${
                    paymentType === "full"
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  {t("pos.pay_full")}
                </button>
              </>
            ) : appointment.depositPaid ? (
              <button
                onClick={() => onPaymentTypeChange("balance")}
                className={`flex-1 px-3 py-2 text-sm rounded-lg border ${
                  paymentType === "balance"
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                }`}
              >
                {t("pos.pay_balance")} - {formatCurrency(appointment.totalAmount - (appointment.depositAmount || 0))}
              </button>
            ) : null}
          </div>
          <div className="text-xs text-gray-500 mt-2">{getPaymentDescription()}</div>
        </div>
      )}

      {appointment.payments && appointment.payments.length > 0 && (
        <div className="border-t pt-3">
          <div className="text-sm font-medium text-gray-700 mb-2">{t("pos.payment_history")}</div>
          <div className="space-y-1">
            {appointment.payments.map((payment) => (
              <div key={payment.id} className="flex justify-between text-sm">
                <span className="text-gray-600">
                  {payment.isDeposit ? t("pos.deposit") : t("pos.payment")} - {payment.status}
                </span>
                <span className="font-medium">{formatCurrency(payment.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
