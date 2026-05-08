import { MonitorPlay, Eye, Shield, ArrowRight, Sparkles } from "lucide-react";
import { t } from "../i18n";
interface Props {
  navigate: (to: "home" | "host" | "client") => void;
  embed?: boolean;
}
export function Home({
  navigate,
  embed = false
}: Props) {
  return <div className={["w-full max-w-5xl animate-slide-up px-3 sm:px-0", embed ? "m-auto" : ""].join(" ")}>
      <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl bg-white border border-line shadow-soft-xl p-6 sm:p-8 md:p-12">
        <div className="absolute inset-0 bg-dots opacity-50 pointer-events-none" />

        <div className="relative">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary-soft text-primary text-[11px] sm:text-xs font-medium tracking-wide mb-4 sm:mb-6">
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t("nav.badge")}</span>
          </div>

          <h1 className="text-3xl xs:text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-[1.05] mb-4 sm:mb-5">
            <span className="text-gradient">{t("home.title")}</span>
            <br />
            <span className="text-text700 text-xl xs:text-2xl sm:text-3xl md:text-4xl font-semibold">
              {t("home.titleSub")}
            </span>
          </h1>

          <p className="text-sm sm:text-base md:text-lg text-text500 max-w-2xl leading-relaxed mb-7 sm:mb-10">
            {t("home.intro")}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 md:gap-5">
            <a className="group relative flex flex-col gap-2 sm:gap-3 p-4 sm:p-6 rounded-xl sm:rounded-2xl border border-line bg-white transition-all duration-300 hover:border-primary/40 hover:-translate-y-1 hover:shadow-glow overflow-hidden" href="#/host" onClick={e => {
            e.preventDefault();
            navigate("host");
          }}>
              <div className="relative flex items-start justify-between">
                <span className="inline-flex items-center justify-center w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-primary-soft border border-primary/20 text-primary group-hover:scale-110 transition-transform duration-300">
                  <MonitorPlay className="w-5 h-5 sm:w-6 sm:h-6" strokeWidth={2.2} />
                </span>
                <ArrowRight className="w-5 h-5 text-text400 group-hover:text-primary group-hover:translate-x-1 transition-all duration-300" />
              </div>
              <span className="relative text-base sm:text-lg font-semibold tracking-tight text-text900">
                {t("home.host.title")}
              </span>
              <span className="relative text-[13px] sm:text-sm text-text500 leading-relaxed">
                {t("home.host.desc")}
              </span>
            </a>

            <a className="group relative flex flex-col gap-2 sm:gap-3 p-4 sm:p-6 rounded-xl sm:rounded-2xl border border-line bg-white transition-all duration-300 hover:border-primary/40 hover:-translate-y-1 hover:shadow-glow overflow-hidden" href="#/client" onClick={e => {
            e.preventDefault();
            navigate("client");
          }}>
              <div className="relative flex items-start justify-between">
                <span className="inline-flex items-center justify-center w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-primary-soft border border-primary/20 text-primary group-hover:scale-110 transition-transform duration-300">
                  <Eye className="w-5 h-5 sm:w-6 sm:h-6" strokeWidth={2.2} />
                </span>
                <ArrowRight className="w-5 h-5 text-text400 group-hover:text-primary group-hover:translate-x-1 transition-all duration-300" />
              </div>
              <span className="relative text-base sm:text-lg font-semibold tracking-tight text-text900">
                {t("home.client.title")}
              </span>
              <span className="relative text-[13px] sm:text-sm text-text500 leading-relaxed">
                {t("home.client.desc")}
              </span>
            </a>
          </div>

          <div className="mt-6 sm:mt-8 flex items-start gap-3 p-3 sm:p-4 rounded-xl border border-primary/15 bg-primary-soft">
            <span className="shrink-0 mt-0.5 inline-flex items-center justify-center w-8 h-8 rounded-lg bg-white border border-primary/15 text-primary">
              <Shield className="w-4 h-4" strokeWidth={2.4} />
            </span>
            <p className="text-[13px] sm:text-sm text-text700 leading-relaxed">
              <strong className="font-semibold text-text900">{t("home.privacy.label")}</strong>{" "}
              {t("home.privacy.body")}
            </p>
          </div>
        </div>
      </div>
    </div>;
}
