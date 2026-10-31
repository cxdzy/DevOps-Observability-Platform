<script setup lang="ts">
import type { ModelInfo, ModelVersionInfo } from '@/types'
import { computed, ref } from 'vue'
import { Skeleton } from '@/components/ui/skeleton'
import { api, usePoll } from '@/composables/useApi'
import { fixed, localDateTime, shortDate } from '@/lib/format'

// refreshed drives the live dot in the top bar; champion feeds the version shown in the sidebar.
const emit = defineEmits<{ refreshed: [ok: boolean], champion: [version: string | null] }>()

const info = ref<ModelInfo | null>(null)
const loading = ref(true)
const failed = ref(false)

async function load() {
  try {
    const { data } = await api.get<ModelInfo>('/api/model')
    info.value = data
    failed.value = false
    emit('refreshed', true)
    emit('champion', data.champion?.version ?? null)
  } catch {
    failed.value = true
    emit('refreshed', false)
  } finally {
    loading.value = false
  }
}

// The registry changes at most once a night, so every 5 minutes is plenty.
usePoll(load, 5 * 60 * 1000)

const champion = computed(() => info.value?.champion ?? null)
const retrain = computed(() => info.value?.lastRetrain ?? null)
const rules = computed(() => info.value?.rules ?? null)

function threshold(version: string | null | undefined): number | null {
  if (!version) return null
  return info.value?.thresholds?.find(t => t.version === version)?.threshold ?? null
}

// model_retrain values arrive as numbers or strings; missing ones are null.
function rnum(key: string): number | null {
  const v = retrain.value?.[key]
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function rtext(key: string): string | null {
  const v = retrain.value?.[key]
  return v === null || v === undefined || v === '' ? null : String(v)
}

const promoted = computed(() => rnum('promoted') === 1)
const retrainResult = computed(() => {
  if (!retrain.value) return null
  if (promoted.value) return `Promoted v${rtext('new_version') ?? '?'}`
  return `Kept v${rtext('champion_version') ?? '?'}`
})

// Faults the champion caught in the last retraining test, when that run tested this champion.
const faults = computed(() => {
  const c = champion.value
  const total = rnum('test_injections')
  if (!c || !retrain.value || total === null) return null
  if (promoted.value && rtext('new_version') === c.version) return { caught: rnum('challenger_inj_detected'), total }
  if (!promoted.value && rtext('champion_version') === c.version) return { caught: rnum('champion_inj_detected'), total }
  return null
})

// One sentence, in the same order as the worker's promotion checks.
const reason = computed(() => {
  const r = rules.value
  if (!retrain.value || !r) return null
  const anomalies = rnum('test_anomalies')
  const injections = rnum('test_injections')
  const champF1 = rnum('champion_f1')
  const challF1 = rnum('challenger_f1')
  const injRate = rnum('challenger_inj_rate')
  const recall = rnum('challenger_recall')
  if (promoted.value) {
    return champF1 !== null && challF1 !== null
      ? `The challenger beat the champion by ${fixed(challF1 - champF1, 4)} and passed every check.`
      : 'The challenger passed every check.'
  }
  if (anomalies !== null && anomalies < r.minTestAnomalies) {
    return `Only ${anomalies} anomalous test minutes, ${r.minTestAnomalies} are needed for a fair comparison.`
  }
  if (injections !== null && injections < r.minTestInjections) {
    return `Only ${injections} test faults, ${r.minTestInjections} are needed for a fair comparison.`
  }
  if (champF1 !== null && challF1 !== null && challF1 < champF1 + r.promoteMargin) {
    return `The challenger did not beat the champion by ${r.promoteMargin}.`
  }
  if (injRate !== null && injRate < r.minInjectionDetection) {
    return `The challenger caught ${Math.round(injRate * 100)}% of the test faults, below ${Math.round(r.minInjectionDetection * 100)}%.`
  }
  if (recall !== null && recall < r.minRecall) {
    return `The challenger's minute recall ${fixed(recall, 2)} is below ${fixed(r.minRecall, 2)}.`
  }
  return null
})

const bars = computed(() => [
  { label: `Champion v${rtext('champion_version') ?? '?'}`, f1: rnum('champion_f1'), color: 'bg-chartline' },
  { label: 'Best challenger', f1: rnum('challenger_f1'), color: 'bg-faint' },
])

function role(v: ModelVersionInfo): 'Champion' | 'Previous' | null {
  if (v.aliases.includes('champion')) return 'Champion'
  if (v.aliases.includes('previous')) return 'Previous'
  return null
}

// The retraining hour in the browser's time zone, for example 03:00 for 19:00 UTC in Malaysia.
const retrainLocal = computed(() => {
  const hour = rules.value?.retrainHourUtc ?? 19
  const d = new Date()
  d.setUTCHours(hour, 0, 0, 0)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
})

const card = 'flex min-w-0 flex-col gap-4 rounded-xl border border-border p-[18px]'
const chip = 'rounded-md px-2 py-px text-xs font-medium'
const noData = 'text-muted-foreground'
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold tracking-[-0.02em]">Model</h1>
    <p class="mt-0.5 text-[13px] text-muted-foreground">The Isolation Forest that scores every minute, retrained each night at {{ retrainLocal }}</p>
  </div>

  <template v-if="loading">
    <div class="flex flex-wrap gap-4">
      <Skeleton class="h-[240px] min-w-0 flex-[3_1_440px] rounded-xl" />
      <Skeleton class="h-[240px] min-w-0 flex-[2_1_320px] rounded-xl" />
    </div>
    <Skeleton class="h-48 rounded-xl" />
  </template>

  <p v-else-if="failed && !info" class="rounded-lg bg-tier-high-bg p-3 text-[13px] text-tier-high-fg" role="alert">
    MLflow and InfluxDB did not answer. Retrying in 5 minutes.
  </p>

  <template v-else-if="info">
    <p v-if="failed" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
      Could not refresh. Showing the last loaded data.
    </p>
    <p v-if="!info.mlflowOk" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
      MLflow did not answer, so the registry details show No data. Retrying in 5 minutes.
    </p>
    <p v-if="!info.influxOk" class="rounded-lg bg-tier-medium-bg p-2.5 text-[13px] text-tier-medium-fg" role="status">
      InfluxDB did not answer, so thresholds and the last retraining show No data. Retrying in 5 minutes.
    </p>

    <div class="flex flex-wrap items-stretch gap-4">
      <section aria-labelledby="champion-title" :class="card" class="flex-[3_1_440px]">
        <div class="flex items-center justify-between gap-2">
          <h2 id="champion-title" class="text-[15px] font-semibold">Champion</h2>
          <span v-if="champion?.createdAt" :class="chip" class="bg-okbg text-ok">In use since {{ shortDate(champion.createdAt) }}</span>
        </div>
        <div class="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
          <span v-if="champion" class="font-mono text-5xl leading-none font-medium tracking-[-0.03em]">v{{ champion.version }}</span>
          <span v-else class="text-[22px] font-semibold text-muted-foreground">No data</span>
          <span class="text-muted-foreground">
            threshold
            <span v-if="threshold(champion?.version) !== null" class="font-mono text-foreground">{{ fixed(threshold(champion?.version)) }}</span>
            <span v-else>No data</span>
          </span>
        </div>
        <dl class="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] overflow-hidden rounded-[10px] border border-border">
          <div class="-mr-px border-r border-border px-3 py-2.5">
            <dt class="text-xs text-muted-foreground">Test F1 at promotion</dt>
            <dd class="mt-0.5 text-base" :class="champion?.testF1 == null ? noData : 'font-mono'">{{ champion?.testF1 == null ? 'No data' : fixed(champion.testF1, 4) }}</dd>
          </div>
          <div class="-mr-px border-r border-border px-3 py-2.5">
            <dt class="text-xs text-muted-foreground">Faults caught</dt>
            <dd class="mt-0.5 text-base">
              <template v-if="faults && faults.caught !== null"><span class="font-mono">{{ faults.caught }}</span> of {{ faults.total }}</template>
              <span v-else :class="noData">No data</span>
            </dd>
          </div>
          <div class="px-3 py-2.5">
            <dt class="text-xs text-muted-foreground">Promoted</dt>
            <dd class="mt-0.5 text-base" :class="champion?.createdAt ? '' : noData">{{ champion?.createdAt ? localDateTime(champion.createdAt) : 'No data' }}</dd>
          </div>
        </dl>
        <p v-if="champion?.runId" class="text-xs text-muted-foreground">MLflow run <span class="font-mono">{{ champion.runId }}</span></p>
      </section>

      <section aria-labelledby="retrain-title" :class="card" class="flex-[2_1_320px] gap-3.5">
        <div class="flex items-center justify-between gap-2">
          <h2 id="retrain-title" class="text-[15px] font-semibold">Last retraining</h2>
          <span v-if="retrainResult" :class="chip" class="bg-chip text-chipfg">{{ retrainResult }}</span>
        </div>
        <!-- Both models are scored on the newest test set here, so the champion's F1 can differ from
             its F1 at promotion on the Champion card. -->
        <p class="-mt-2.5 text-xs text-muted-foreground">F1 on the latest test set</p>
        <template v-if="retrain">
          <div class="font-mono text-[13px] text-muted-foreground">{{ rnum('time') !== null ? localDateTime(rnum('time')) : 'No data' }}</div>
          <div class="flex flex-col gap-2.5">
            <div v-for="b in bars" :key="b.label" class="flex flex-col gap-1.5">
              <div class="flex justify-between gap-2">
                <span>{{ b.label }}</span>
                <span :class="b.f1 === null ? noData : 'font-mono'">{{ b.f1 === null ? 'No data' : fixed(b.f1, 4) }}</span>
              </div>
              <div class="h-1.5 rounded-full bg-track" role="img" :aria-label="b.f1 === null ? 'No data' : `F1 ${fixed(b.f1, 4)}`">
                <div v-if="b.f1 !== null" class="h-1.5 rounded-full" :class="b.color" :style="{ width: `${Math.max(0, Math.min(1, b.f1)) * 100}%` }" />
              </div>
            </div>
          </div>
          <p class="mt-auto text-[13px] text-muted-foreground">{{ reason ?? 'No data' }}</p>
        </template>
        <p v-else class="text-[13px] text-muted-foreground">No data. No retraining has been recorded yet.</p>
      </section>
    </div>

    <div class="flex flex-wrap items-start gap-4">
      <section aria-labelledby="versions-title" class="min-w-0 flex-[3_1_440px] overflow-hidden rounded-xl border border-border">
        <h2 id="versions-title" class="px-[18px] py-3.5 text-[15px] font-semibold">Versions</h2>
        <p v-if="!info.versions" class="border-t border-border px-[18px] py-6 text-[13px] text-muted-foreground">No data</p>
        <p v-else-if="info.versions.length === 0" class="border-t border-border px-[18px] py-6 text-[13px] text-muted-foreground">No versions in the registry yet</p>
        <div v-else class="overflow-x-auto">
          <table class="w-full min-w-[480px] text-left">
            <thead class="bg-chip text-xs font-medium text-muted-foreground">
              <tr>
                <th scope="col" class="px-[18px] py-2 font-medium">Version</th>
                <th scope="col" class="px-[18px] py-2 font-medium">Role</th>
                <th scope="col" class="px-[18px] py-2 font-medium">Threshold</th>
                <th scope="col" class="px-[18px] py-2 font-medium">Test F1</th>
                <th scope="col" class="px-[18px] py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="v in info.versions" :key="v.version" class="border-t border-border">
                <td class="px-[18px] py-3 font-mono font-medium">v{{ v.version }}</td>
                <td class="px-[18px] py-3">
                  <span v-if="role(v) === 'Champion'" :class="chip" class="bg-okbg text-ok">Champion</span>
                  <span v-else-if="role(v) === 'Previous'" :class="chip" class="bg-chip text-chipfg">Previous</span>
                  <span v-else class="text-muted-foreground">-</span>
                </td>
                <td class="px-[18px] py-3" :class="threshold(v.version) === null ? noData : 'font-mono'">
                  {{ threshold(v.version) === null ? 'No data' : fixed(threshold(v.version)) }}
                </td>
                <td class="px-[18px] py-3" :class="v.testF1 === null ? noData : 'font-mono'">{{ v.testF1 === null ? 'No data' : fixed(v.testF1, 4) }}</td>
                <td class="px-[18px] py-3" :class="v.createdAt === null ? noData : ''">{{ v.createdAt === null ? 'No data' : shortDate(v.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="rules" aria-labelledby="rules-title" class="flex min-w-0 flex-[2_1_320px] flex-col gap-3 rounded-xl border border-border px-[18px] py-4">
        <h2 id="rules-title" class="text-[15px] font-semibold">
          A new model replaces {{ champion ? `v${champion.version}` : 'the champion' }} only if
        </h2>
        <ul class="flex flex-col text-[13px]">
          <li class="flex justify-between gap-2.5 border-t border-border py-2"><span class="text-muted-foreground">Its test F1 beats the champion by</span><span class="font-mono">{{ rules.promoteMargin }} or more</span></li>
          <li class="flex justify-between gap-2.5 border-t border-border py-2"><span class="text-muted-foreground">Test faults it catches</span><span class="font-mono">{{ Math.round(rules.minInjectionDetection * 100) }}% or more</span></li>
          <li class="flex justify-between gap-2.5 border-t border-border py-2"><span class="text-muted-foreground">Share of anomalous test minutes it flags</span><span class="font-mono">{{ fixed(rules.minRecall, 2) }} or more</span></li>
          <li class="flex justify-between gap-2.5 border-t border-border py-2"><span class="text-muted-foreground">Test faults available to compare</span><span class="font-mono">{{ rules.minTestInjections }} or more</span></li>
          <li class="flex justify-between gap-2.5 border-t border-border py-2"><span class="text-muted-foreground">Anomalous test minutes available</span><span class="font-mono">{{ rules.minTestAnomalies }} or more</span></li>
        </ul>
        <p class="text-xs text-muted-foreground">The full training history stays in Grafana and MLflow.</p>
      </section>
    </div>
  </template>
</template>
