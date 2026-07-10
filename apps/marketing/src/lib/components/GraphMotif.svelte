<!--
	Hand-rolled node-graph motif: a slice of a product-knowledge vault.
	Pure inline SVG + CSS animation, no runtime deps. Motion is disabled
	globally via the prefers-reduced-motion rule in app.css.
-->
<svg viewBox="0 0 640 470" role="img" aria-label="A knowledge graph of linked product concepts">
	<!-- edges -->
	<g class="edges">
		<line x1="320" y1="165" x2="185" y2="88" class="flow" />
		<line x1="320" y1="165" x2="478" y2="92" class="typed" />
		<line x1="320" y1="165" x2="128" y2="255" />
		<line x1="320" y1="165" x2="468" y2="258" class="flow d2" />
		<line x1="320" y1="165" x2="252" y2="335" class="typed" />
		<line x1="468" y1="258" x2="425" y2="382" />
		<line x1="468" y1="258" x2="578" y2="335" class="typed" />
		<line x1="185" y1="88" x2="425" y2="382" class="faint" />
		<line x1="128" y1="255" x2="252" y2="335" />
		<line x1="478" y1="92" x2="592" y2="178" class="pending-edge" />
	</g>

	<!-- edge relation labels -->
	<g class="rels">
		<text x="238" y="115">depends_on</text>
		<text x="416" y="118">constrains</text>
		<text x="266" y="262">part_of</text>
	</g>

	<!-- nodes -->
	<g class="node hub" transform="translate(320,165)">
		<circle r="17" class="halo" />
		<circle r="11" />
		<text y="34">billing-engine</text>
	</g>
	<g class="node" transform="translate(185,88)">
		<circle r="8" class="pulse" />
		<text y="-16">ledger</text>
	</g>
	<g class="node" transform="translate(478,92)">
		<circle r="8" />
		<text y="-16">rate-limits</text>
	</g>
	<g class="node" transform="translate(128,255)">
		<circle r="8" />
		<text y="28">auth-session</text>
	</g>
	<g class="node" transform="translate(468,258)">
		<circle r="9" class="pulse d2" />
		<text y="30">webhooks</text>
	</g>
	<g class="node" transform="translate(252,335)">
		<circle r="8" />
		<text y="30">lead-scoring</text>
	</g>
	<g class="node" transform="translate(425,382)">
		<circle r="7" />
		<text y="28">audit-log</text>
	</g>
	<g class="node" transform="translate(578,335)">
		<circle r="7" class="pulse d3" />
		<text y="28">usage-metering</text>
	</g>
	<g class="node pending" transform="translate(592,178)">
		<circle r="7" />
		<text y="-15">tax-rules</text>
	</g>
</svg>

<style>
	svg {
		width: 100%;
		height: auto;
		display: block;
	}

	.edges line {
		stroke: var(--edge);
		stroke-width: 1.4;
	}
	.edges .typed {
		stroke-dasharray: 5 4;
	}
	.edges .faint {
		stroke-opacity: 0.35;
	}
	.edges .flow {
		stroke: var(--accent);
		stroke-opacity: 0.75;
		stroke-width: 1.7;
		stroke-dasharray: 4 7;
		animation: flow 1.6s linear infinite;
	}
	.edges .flow.d2 {
		animation-delay: -0.8s;
	}
	.edges .pending-edge {
		stroke-dasharray: 2 4;
		stroke-opacity: 0.6;
	}

	.rels text {
		fill: var(--text-dim);
		font: 10.5px var(--font-mono);
		opacity: 0.85;
	}

	.node circle {
		fill: var(--accent);
		stroke: rgb(255 255 255 / 0.25);
		stroke-width: 1;
	}
	.node text {
		fill: var(--text-dim);
		font: 12px var(--font-mono);
		text-anchor: middle;
		paint-order: stroke;
		stroke: var(--bg);
		stroke-width: 4px;
	}
	.node.hub text {
		fill: var(--text);
	}
	.node.hub .halo {
		fill: var(--accent);
		fill-opacity: 0.16;
		stroke: none;
		animation: halo 3.2s ease-in-out infinite;
	}
	.node.pending circle {
		fill-opacity: 0.3;
		fill: var(--text-dim);
		stroke: var(--text-dim);
		stroke-dasharray: 3 3;
	}
	.node.pending text {
		font-style: italic;
	}

	.pulse {
		transform-box: fill-box;
		transform-origin: center;
		animation: pulse 3.2s ease-in-out infinite;
	}
	.pulse.d2 {
		animation-delay: -1.1s;
	}
	.pulse.d3 {
		animation-delay: -2.2s;
	}

	@keyframes flow {
		to {
			stroke-dashoffset: -22;
		}
	}
	@keyframes pulse {
		0%,
		100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.25);
		}
	}
	@keyframes halo {
		0%,
		100% {
			transform: scale(1);
			fill-opacity: 0.16;
		}
		50% {
			transform: scale(1.5);
			fill-opacity: 0.07;
		}
	}
	.node.hub .halo {
		transform-box: fill-box;
		transform-origin: center;
	}
</style>
