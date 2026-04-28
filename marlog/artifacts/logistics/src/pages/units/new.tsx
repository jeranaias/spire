import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/page-header";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useCreateUnit, getListUnitsQueryKey } from "@workspace/api-client-react";
import { Echelon, Climate, OpTempo } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  callsign: z.string().optional(),
  echelon: z.nativeEnum(Echelon),
  personnel: z.coerce.number().min(1, "Must have at least 1 person"),
  commander: z.string().optional(),
  location: z.string().optional(),
  climate: z.nativeEnum(Climate),
  opTempo: z.nativeEnum(OpTempo),
  missionDays: z.coerce.number().min(1, "Must be at least 1 day"),
});

export default function NewUnit() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createUnit = useCreateUnit();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      callsign: "",
      echelon: "platoon",
      personnel: 40,
      commander: "",
      location: "",
      climate: "temperate",
      opTempo: "garrison",
      missionDays: 30,
    },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const unit = await createUnit.mutateAsync({ data: values });
      queryClient.invalidateQueries({ queryKey: getListUnitsQueryKey() });
      toast({ title: "Unit created", description: "The unit has been added successfully." });
      setLocation(`/units/${unit.id}`);
    } catch (error) {
      toast({ title: "Error", description: "Failed to create unit.", variant: "destructive" });
    }
  }

  return (
    <Layout>
      <Title title="New Unit" />
      
      <Link href="/units" className="inline-flex items-center text-xs font-mono text-muted-foreground hover:text-foreground transition-colors mb-4 tracking-widest uppercase">
        <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
        Units
      </Link>
      <PageHeader
        title="Add Unit"
        tag="Register"
        subtitle="Register a new subordinate element"
      />

      <Card className="max-w-2xl">
        <CardContent className="p-6">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs">Unit Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 1st Platoon, Alpha Co" className="font-mono" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="callsign"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs">Callsign (Optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. WARLORD 1" className="font-mono" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="echelon"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs">Echelon</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="font-mono uppercase">
                            <SelectValue placeholder="Select echelon" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.values(Echelon).map(e => (
                            <SelectItem key={e} value={e} className="font-mono uppercase">{e}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="personnel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs">Personnel (PAX)</FormLabel>
                      <FormControl>
                        <Input type="number" min="1" className="font-mono" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="commander"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs">Commander / OIC</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. 1stLt Smith" className="font-mono" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="location"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs">Location</FormLabel>
                      <FormControl>
                        <Input placeholder="Grid or Base" className="font-mono" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="climate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs">Climate Zone</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="font-mono uppercase">
                            <SelectValue placeholder="Select climate" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.values(Climate).map(c => (
                            <SelectItem key={c} value={c} className="font-mono uppercase">{c}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="opTempo"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs">Operations Tempo</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="font-mono uppercase">
                            <SelectValue placeholder="Select tempo" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.values(OpTempo).map(o => (
                            <SelectItem key={o} value={o} className="font-mono uppercase">{o}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="missionDays"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-xs">Mission Duration (Days)</FormLabel>
                      <FormControl>
                        <Input type="number" min="1" className="font-mono" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="flex justify-end pt-4 border-t border-border">
                <Button type="submit" disabled={createUnit.isPending} className="font-mono uppercase tracking-wider">
                  {createUnit.isPending ? "Saving..." : <><Save className="w-4 h-4 mr-2" /> Save Unit</>}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </Layout>
  );
}
