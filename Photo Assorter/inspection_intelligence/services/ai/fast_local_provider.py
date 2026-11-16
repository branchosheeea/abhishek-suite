"""CPU image/text similarity for a fast, reviewable first pass. No network calls."""
import hashlib
import json
import sys
from pathlib import Path
from time import monotonic

from PIL import Image, ImageOps

from inspection_intelligence.models import ClassificationDecision


# Describe locations rather than generic words such as "bridge" or "tank".
DESCRIPTIONS = {
    'Hull': ['outside hull of a merchant ship, steel shell plating and waterline',
             'ship hull exterior, draft marks and rudder or propeller'],
    'Main Deck': ['open main deck of a merchant ship with deck plating and pipes',
                  'ship deck walkway with railings, mooring winches and bollards'],
    'Cargo Area': ['ship cargo hold with cargo handling equipment',
                   'cargo manifold loading station and cargo cranes on a tanker'],
    'Tanks': ['inside a ship ballast tank, steel stiffeners and enclosed rusty plating',
              'interior of a ship cargo tank with structural frames'],
    'Superstructure': ['outside ship accommodation block, exterior stairs and walls',
                       'ship superstructure exterior with windows and balconies'],
    'Bridge': ['inside a ship navigation bridge with radar screens and navigation consoles',
               'ship wheelhouse with forward windows, helm and bridge instruments'],
    'Accommodation': ['inside ship crew accommodation, cabins, galley and mess room',
                      'ship living quarters, beds, dining tables and interior corridors'],
    'CCR': ['inside a tanker cargo control room with cargo monitoring consoles',
            'ship cargo control room with ballast and cargo control panels'],
    'ECR': ['ship engine control room with electrical switchboards and monitoring consoles',
            'engine control room with control desks and engine alarm panels'],
    'Engine Room': ['inside a ship engine room with large diesel engines, pipes and pumps',
                    'marine engine room machinery, purifiers, generators and boilers'],
    'Steering Gear Room': ['inside ship steering gear room with hydraulic rams and rudder stock',
                           'marine steering gear hydraulic cylinders and tiller machinery'],
    'Workshops & Stores': ['ship workshop with workbench, lathe, tools and spare parts',
                           'ship storeroom with shelves and maintenance supplies'],
    'Safety Equipment': ['self contained breathing apparatus SCBA and emergency escape breathing device EEBD',
                         'ship safety equipment, lifejackets, lifebuoys, lifeboats and fire extinguishers'],
    'Documentation & Certificates': ['photograph of a printed certificate or inspection document',
                                     'ship paperwork, record books, certificates and printed forms'],
}


class FastLocalProvider:
    model_name = 'local-clip-vit-b32-q8'

    def __init__(self, model_directory: Path, taxonomy, minimum_similarity=.22, minimum_margin=.015):
        self.model_directory = model_directory
        self.taxonomy = taxonomy
        self.minimum_similarity = minimum_similarity
        self.minimum_margin = minimum_margin
        self.last_metrics = {}
        self._ready = False
        self._signature = None

    @property
    def cache_signature(self):
        return self._signature

    def ensure_available(self):
        if self._ready:
            return
        try:
            import numpy as np
            import onnxruntime as ort
            from tokenizers import Tokenizer
        except ImportError as error:
            missing_module = error.name or "an inference dependency"
            raise RuntimeError(
                f"Fast local sorting cannot start because '{missing_module}' is missing "
                f"from the active Python environment ({sys.executable}). "
                "Run setup_fast_mode.cmd once, then start the app with Start Inspection.cmd."
            ) from error
        required = ['onnx/text_model_quantized.onnx', 'onnx/vision_model_quantized.onnx',
                    'tokenizer.json', 'preprocessor_config.json']
        if any(not (self.model_directory / name).is_file() for name in required):
            raise RuntimeError('Fast model files are missing. Run python setup_fast_model.py once.')
        self.np = np
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        self.vision = ort.InferenceSession(str(self.model_directory / required[1]),
            sess_options=options, providers=['CPUExecutionProvider'])
        text_model = ort.InferenceSession(str(self.model_directory / required[0]),
            sess_options=options, providers=['CPUExecutionProvider'])
        tokenizer = Tokenizer.from_file(str(self.model_directory / 'tokenizer.json'))
        tokenizer.enable_padding(pad_id=49407, length=77)
        tokenizer.enable_truncation(max_length=77)
        self.labels = [label for label in self.taxonomy.values if label != self.taxonomy.review_required]
        prompts, groups = [], []
        for label in self.labels:
            descriptions = DESCRIPTIONS.get(label, [f'a vessel inspection photo of {label}'])
            groups.append((len(prompts), len(prompts) + len(descriptions)))
            prompts.extend(f'A photo of {description}.' for description in descriptions)
        tokens = tokenizer.encode_batch(prompts)
        inputs = {'input_ids': np.array([token.ids for token in tokens], dtype=np.int64),
                  'attention_mask': np.array([token.attention_mask for token in tokens], dtype=np.int64)}
        inputs = {item.name: inputs[item.name] for item in text_model.get_inputs()}
        embeddings = text_model.run(['text_embeds'], inputs)[0]
        embeddings /= np.maximum(np.linalg.norm(embeddings, axis=-1, keepdims=True), 1e-12)
        self.text_embeddings = np.array([embeddings[start:end].mean(axis=0) for start, end in groups])
        self.text_embeddings /= np.maximum(np.linalg.norm(self.text_embeddings, axis=-1, keepdims=True), 1e-12)
        # Hash actual weights/config, not just filenames, to invalidate stale decisions.
        digest = hashlib.sha256()
        for name in required:
            with (self.model_directory / name).open('rb') as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(chunk)
        digest.update(json.dumps((prompts, self.taxonomy.review_required, self.minimum_similarity,
                                 self.minimum_margin, 'center-and-full-image-v1')).encode())
        self._signature = digest.hexdigest()
        self._ready = True

    def classify(self, image_path: Path):
        self.ensure_available()
        started = monotonic()
        np = self.np
        with Image.open(image_path) as original:
            image = ImageOps.exif_transpose(original).convert('RGB')
        # Center detail plus the full scene so the image edges are not discarded.
        views = [ImageOps.fit(image, (224, 224), method=Image.Resampling.BICUBIC),
                 ImageOps.pad(image, (224, 224), method=Image.Resampling.BICUBIC, color=(123, 117, 104))]
        pixels = np.stack([np.asarray(view, dtype=np.float32) / 255 for view in views])
        pixels = (pixels - np.array([.48145466, .4578275, .40821073], dtype=np.float32)) / np.array(
            [.26862954, .26130258, .27577711], dtype=np.float32)
        pixels = pixels.transpose(0, 3, 1, 2).copy()
        prepare_seconds = monotonic() - started
        embeddings = self.vision.run(['image_embeds'], {'pixel_values': pixels})[0]
        embeddings /= np.maximum(np.linalg.norm(embeddings, axis=-1, keepdims=True), 1e-12)
        scores = (embeddings @ self.text_embeddings.T).mean(axis=0)
        order = np.argsort(scores)[::-1]
        best, runner_up = int(order[0]), int(order[1])
        similarity = float(scores[best])
        margin = similarity - float(scores[runner_up])
        uncertain = similarity < self.minimum_similarity or margin < self.minimum_margin
        label = self.taxonomy.review_required if uncertain else self.labels[best]
        reason = (f"Visual similarity suggests {self.labels[best]}; alternative: {self.labels[runner_up]}. "
                  f"Similarity {similarity:.3f}, margin {margin:.3f}. "
                  "This is a sorting suggestion, not a calibrated probability or an assessment of condition.")
        if uncertain:
            reason = 'Uncertain category; please review. ' + reason
        self.last_metrics = {'prepare_seconds': round(prepare_seconds, 3),
                             'wall_seconds': round(monotonic() - started, 3)}
        return ClassificationDecision(label, max(0., min(1., similarity)), reason)
