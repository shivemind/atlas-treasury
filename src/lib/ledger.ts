import {
  LedgerAccount,
  LedgerAccountType,
  LedgerEntryStatus,
  LedgerLineDirection,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import { prisma } from "./prisma";

type LedgerPrismaClient = PrismaClient | Prisma.TransactionClient;

type LedgerLineInput = {
  accountId: string;
  direction: LedgerLineDirection;
  amount: number;
};

type PostJournalEntryInput = {
  merchantId: string;
  reference?: string;
  description?: string;
  status?: LedgerEntryStatus;
  postedAt?: Date;
  lines: LedgerLineInput[];
  prismaClient?: LedgerPrismaClient;
};

type LedgerInvariantTotals = {
  debitTotal: number;
  creditTotal: number;
};

type MerchantBalances = {
  available: number;
  pending: number;
  fees: number;
  platformFees: number;
  processorFees: number;
};

type CaptureSettlementInput = {
  merchantId: string;
  amount: number;
  currency: string;
  reference?: string;
  prismaClient?: LedgerPrismaClient;
};

type RefundSettlementInput = {
  merchantId: string;
  amount: number;
  currency: string;
  reference?: string;
  prismaClient?: LedgerPrismaClient;
};

export const BALANCE_AVAILABLE_ACCOUNT_CODE = "BALANCE_AVAILABLE";
export const BALANCE_PENDING_ACCOUNT_CODE = "BALANCE_PENDING";
export const FEES_ACCOUNT_CODE = "FEES";
export const PLATFORM_FEES_ACCOUNT_CODE = "PLATFORM_FEES";
export const PROCESSOR_FEES_ACCOUNT_CODE = "PROCESSOR_FEES";

export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInvariantError";
  }
}

function assertValidLineAmounts(lines: LedgerLineInput[]) {
  if (lines.length === 0) {
    throw new LedgerInvariantError("Journal entry must include at least one ledger line.");
  }

  for (const line of lines) {
    if (!Number.isInteger(line.amount) || line.amount <= 0) {
      throw new LedgerInvariantError("Ledger line amounts must be positive integers.");
    }
  }
}

function calculateTotals(lines: LedgerLineInput[]): LedgerInvariantTotals {
  return lines.reduce<LedgerInvariantTotals>(
    (totals, line) => {
      if (line.direction === "DEBIT") {
        totals.debitTotal += line.amount;
      }

      if (line.direction === "CREDIT") {
        totals.creditTotal += line.amount;
      }

      return totals;
    },
    {
      debitTotal: 0,
      creditTotal: 0,
    },
  );
}

export function assertBalancedLines(lines: LedgerLineInput[]): void {
  assertValidLineAmounts(lines);

  const totals = calculateTotals(lines);
  if (totals.debitTotal !== totals.creditTotal) {
    throw new LedgerInvariantError(
      `Journal entry is unbalanced: debits=${totals.debitTotal}, credits=${totals.creditTotal}.`,
    );
  }
}

export async function postJournalEntry(input: PostJournalEntryInput) {
  const {
    merchantId,
    reference,
    description,
    status = "POSTED",
    postedAt = new Date(),
    lines,
    prismaClient = prisma,
  } = input;

  assertBalancedLines(lines);

  const createJournal = async (tx: LedgerPrismaClient) => {
    const createdEntry = await tx.ledgerJournalEntry.create({
      data: {
        merchantId,
        reference,
        description,
        status,
        postedAt: status === "POSTED" ? postedAt : null,
      },
    });

    await tx.ledgerLine.createMany({
      data: lines.map((line) => ({
        merchantId,
        journalEntryId: createdEntry.id,
        accountId: line.accountId,
        direction: line.direction,
        amount: line.amount,
      })),
    });

    return tx.ledgerJournalEntry.findUniqueOrThrow({
      where: { id: createdEntry.id },
      include: {
        lines: true,
      },
    });
  };

  const journalEntry =
    "$transaction" in prismaClient
      ? await prismaClient.$transaction(async (tx) => createJournal(tx))
      : await createJournal(prismaClient);

  return journalEntry;
}

export async function assertJournalEntryBalanced(
  journalEntryId: string,
  prismaClient: LedgerPrismaClient = prisma,
): Promise<LedgerInvariantTotals> {
  const lines = await prismaClient.ledgerLine.findMany({
    where: {
      journalEntryId,
    },
    select: {
      direction: true,
      amount: true,
    },
  });

  const typedLines: LedgerLineInput[] = lines.map((line) => ({
    accountId: "",
    direction: line.direction,
    amount: line.amount,
  }));

  assertBalancedLines(typedLines);

  return calculateTotals(typedLines);
}

function normalizeAccountBalance(accountType: LedgerAccountType, debitTotal: number, creditTotal: number) {
  if (accountType === "ASSET" || accountType === "EXPENSE") {
    return debitTotal - creditTotal;
  }

  return creditTotal - debitTotal;
}

export async function getMerchantBalances(
  merchantId: string,
  prismaClient: LedgerPrismaClient = prisma,
): Promise<MerchantBalances> {
  const accounts = await prismaClient.ledgerAccount.findMany({
    where: {
      merchantId,
      code: {
        in: [
          BALANCE_AVAILABLE_ACCOUNT_CODE,
          BALANCE_PENDING_ACCOUNT_CODE,
          FEES_ACCOUNT_CODE,
          PLATFORM_FEES_ACCOUNT_CODE,
          PROCESSOR_FEES_ACCOUNT_CODE,
        ],
      },
    },
    include: {
      lines: {
        select: {
          direction: true,
          amount: true,
        },
      },
    },
  });

  const balancesByCode = new Map<string, number>();

  for (const account of accounts) {
    const debitTotal = account.lines
      .filter((line) => line.direction === "DEBIT")
      .reduce((sum, line) => sum + line.amount, 0);
    const creditTotal = account.lines
      .filter((line) => line.direction === "CREDIT")
      .reduce((sum, line) => sum + line.amount, 0);

    balancesByCode.set(
      account.code,
      normalizeAccountBalance(account.accountType, debitTotal, creditTotal),
    );
  }

  const platformFees = balancesByCode.get(PLATFORM_FEES_ACCOUNT_CODE) ?? 0;
  const processorFees = balancesByCode.get(PROCESSOR_FEES_ACCOUNT_CODE) ?? 0;
  const fees = (balancesByCode.get(FEES_ACCOUNT_CODE) ?? 0) + platformFees + processorFees;

  return {
    available: balancesByCode.get(BALANCE_AVAILABLE_ACCOUNT_CODE) ?? 0,
    pending: balancesByCode.get(BALANCE_PENDING_ACCOUNT_CODE) ?? 0,
    fees,
    platformFees,
    processorFees,
  };
}

async function getOrCreateLedgerAccountByCode(input: {
  merchantId: string;
  code: string;
  name: string;
  accountType: LedgerAccountType;
  currency: string;
  prismaClient: LedgerPrismaClient;
}): Promise<LedgerAccount> {
  const { merchantId, code, name, accountType, currency, prismaClient } = input;

  return prismaClient.ledgerAccount.upsert({
    where: {
      merchantId_code: {
        merchantId,
        code,
      },
    },
    update: {},
    create: {
      merchantId,
      code,
      name,
      accountType,
      currency,
    },
  });
}

export async function ensureMerchantBalanceAccounts(
  merchantId: string,
  currency: string,
  prismaClient: LedgerPrismaClient = prisma,
) {
  const [availableAccount, pendingAccount] = await Promise.all([
    getOrCreateLedgerAccountByCode({
      merchantId,
      code: BALANCE_AVAILABLE_ACCOUNT_CODE,
      name: "Available Balance",
      accountType: "LIABILITY",
      currency,
      prismaClient,
    }),
    getOrCreateLedgerAccountByCode({
      merchantId,
      code: BALANCE_PENDING_ACCOUNT_CODE,
      name: "Pending Balance",
      accountType: "LIABILITY",
      currency,
      prismaClient,
    }),
  ]);

  return {
    availableAccount,
    pendingAccount,
  };
}

export async function postCaptureSettlement(input: CaptureSettlementInput) {
  const { merchantId, amount, currency, reference, prismaClient = prisma } = input;

  const { availableAccount, pendingAccount } = await ensureMerchantBalanceAccounts(
    merchantId,
    currency,
    prismaClient,
  );

  return postJournalEntry({
    merchantId,
    reference,
    description: "Capture settlement: move pending to available",
    prismaClient,
    lines: [
      {
        accountId: pendingAccount.id,
        direction: "DEBIT",
        amount,
      },
      {
        accountId: availableAccount.id,
        direction: "CREDIT",
        amount,
      },
    ],
  });
}

export async function postRefundSettlement(input: RefundSettlementInput) {
  const { merchantId, amount, currency, reference, prismaClient = prisma } = input;

  const { availableAccount, pendingAccount } = await ensureMerchantBalanceAccounts(
    merchantId,
    currency,
    prismaClient,
  );

  return postJournalEntry({
    merchantId,
    reference,
    description: "Refund settlement: move available to pending",
    prismaClient,
    lines: [
      {
        accountId: availableAccount.id,
        direction: "DEBIT",
        amount,
      },
      {
        accountId: pendingAccount.id,
        direction: "CREDIT",
        amount,
      },
    ],
  });
}
