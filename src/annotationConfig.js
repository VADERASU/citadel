export const anomalousColorScheme = {
  citation: {
    baseColor: "#334155",
    boxColor: "rgba(51,65,85,0.18)",
    category: {
      lowRelevancy: {
        baseColor: "#174ea6",
        boxColor: "rgba(54,126,236,0.26)"
      },
      retractedPaper: {
        baseColor: "#a4262c",
        boxColor: "rgba(218,59,61,0.24)"
      },
      selfCitation: {
        baseColor: "#176447",
        boxColor: "rgba(43,169,120,0.25)"
      },
      citationRing: {
        baseColor: "#8a4600",
        boxColor: "rgba(232,151,39,0.32)"
      },
      unreferenced: {
        baseColor: "#566171",
        boxColor: "rgba(140,140,140,0.3)"
      }
    }
  },
  statistic: {
    baseColor: "rgba(217,95,14,1)",
    boxColor: "rgba(217,95,14,0.3)",
    category: {
      testFailure: {
        baseColor: "#6940a6",
        boxColor: "rgba(150,109,212,0.25)"
      },
      valueInconsistency: {
        baseColor: "rgba(255,247,188,1)",
        boxColor: "rgba(255,247,188,0.3)"
      }
    }
  },
  other: {
    baseColor: "rgba(37,52,148,1)",
    boxColor: "rgba(37,52,148,0.3)",
    category: {
      valueInconsistency: {
        baseColor: "rgba(44,127,184,1)",
        boxColor: "rgba(44,127,184,0.3)"
      },
      noRef: {
        baseColor: "rgba(65,182,196,1)",
        boxColor: "rgba(65,182,196,0.3)"
      }
    }
  }
};
